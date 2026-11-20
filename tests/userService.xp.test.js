// tests/userService.xp.test.js
// Unit-тесты ключевой логики XP, Goals v2, антидублей, syncVersion и race conditions.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// db.js проверяет наличие MONGO_URL на этапе импорта (соединение в тестах не открывается)
process.env.MONGO_URL ||= 'mongodb://127.0.0.1:27017/imantap_test';

const {
  GOAL_CATEGORY_MAX_XP,
  LEGACY_GOAL_CATEGORY_MAP,
  normalizeGoalCategoryId,
  updateUserProgress,
  addUserXP,
} = await import('../userService.js');

/**
 * Простая in-memory имитация MongoDB коллекции `users` с поддержкой
 * findOne, updateOne ($set, $inc, $addToSet, $or, $exists) и опциональной задержки
 * для воспроизведения race conditions.
 */
function createFakeDb(initialUsers = [], { readDelayMs = 0 } = {}) {
  const docs = new Map();
  for (const u of initialUsers) {
    docs.set(u.userId, structuredClone(u));
  }

  function matchesFilter(doc, filter) {
    for (const [key, cond] of Object.entries(filter)) {
      if (key === '$or') {
        if (!cond.some(sub => matchesFilter(doc, sub))) return false;
        continue;
      }
      if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
        if ('$exists' in cond) {
          const exists = Object.prototype.hasOwnProperty.call(doc, key) && doc[key] !== undefined;
          if (exists !== cond.$exists) return false;
          continue;
        }
      }
      if (doc[key] !== cond) return false;
    }
    return true;
  }

  const usersCollection = {
    async findOne(filter) {
      if (readDelayMs > 0) await new Promise(r => setTimeout(r, readDelayMs));
      for (const doc of docs.values()) {
        if (matchesFilter(doc, filter)) return structuredClone(doc);
      }
      return null;
    },
    async updateOne(filter, update) {
      if (readDelayMs > 0) await new Promise(r => setTimeout(r, readDelayMs));
      for (const [key, doc] of docs.entries()) {
        if (!matchesFilter(doc, filter)) continue;
        if (update.$set) {
          for (const [f, val] of Object.entries(update.$set)) {
            doc[f] = structuredClone(val);
          }
        }
        if (update.$inc) {
          for (const [f, delta] of Object.entries(update.$inc)) {
            doc[f] = (doc[f] || 0) + delta;
          }
        }
        if (update.$addToSet) {
          for (const [f, spec] of Object.entries(update.$addToSet)) {
            const arr = Array.isArray(doc[f]) ? doc[f] : [];
            const toAdd = spec && spec.$each ? spec.$each : [spec];
            for (const item of toAdd) {
              if (!arr.includes(item)) arr.push(item);
            }
            doc[f] = arr;
          }
        }
        docs.set(key, doc);
        return { matchedCount: 1, modifiedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    },
  };

  return {
    collection(name) {
      if (name !== 'users') throw new Error(`Unexpected collection: ${name}`);
      return usersCollection;
    },
    getRaw(userId) {
      return structuredClone(docs.get(userId));
    },
  };
}

function makeBaseUser(overrides = {}) {
  return {
    userId: 1001,
    location: { timezone: 'Asia/Almaty' },
    xp: 0,
    currentStreak: 0,
    longestStreak: 0,
    lastActiveDate: '',
    syncVersion: 0,
    progress: {},
    preparationProgress: {},
    basicProgress: {},
    earnedTasks: {},
    dailyGoalRecords: {},
    earnedGoalXp: {},
    goalStreaks: {},
    goalCustomItems: {},
    tasbeehRecords: {},
    earnedTasbeehXp: {},
    tasbeehTotals: {},
    memorizedNames: [],
    completedJuzs: [],
    earnedJuzXpIds: [],
    quranKhatams: 0,
    unlockedBadges: [],
    ...overrides,
  };
}

const NOOP_CONTEST = async () => {};
// 2026-04-06 (Понедельник) 12:00 Asia/Almaty = 07:00Z
const MONDAY_NOW = new Date('2026-04-06T07:00:00Z');
const MONDAY_STR = '2026-04-06';
// 2026-04-07 (Вторник) 12:00 Asia/Almaty = 07:00Z
const TUESDAY_NOW = new Date('2026-04-07T07:00:00Z');
const TUESDAY_STR = '2026-04-07';

describe('Goals v2 категории и обратная совместимость', () => {
  test('normalizeGoalCategoryId поддерживает все 6 канонических ключей и legacy-алиасы', () => {
    for (const id of ['namaz', 'quran', 'sadaqa', 'dhikr', 'ilm', 'akhlaq']) {
      assert.equal(normalizeGoalCategoryId(id), id);
      assert.ok(GOAL_CATEGORY_MAX_XP[id] > 0);
    }
    assert.equal(normalizeGoalCategoryId('prayer'), 'namaz');
    assert.equal(normalizeGoalCategoryId('charity'), 'sadaqa');
    assert.equal(normalizeGoalCategoryId('selfdev'), 'ilm');
    assert.equal(LEGACY_GOAL_CATEGORY_MAP.prayer, 'namaz');

    // Неизвестные и подделанные категории отклоняются
    assert.equal(normalizeGoalCategoryId('fasting'), null);
    assert.equal(normalizeGoalCategoryId('hacked_cat'), null);
    assert.equal(normalizeGoalCategoryId(''), null);
    assert.equal(normalizeGoalCategoryId(null), null);
  });

  test('начисляет XP по каноническим категориям, обрезает превышение и блокирует неизвестные категории', async () => {
    const db = createFakeDb([makeBaseUser()]);
    const deps = { db, addContestXp: NOOP_CONTEST, now: MONDAY_NOW };

    const res = await updateUserProgress(1001, {
      syncVersion: 0,
      dailyGoalRecords: {
        [MONDAY_STR]: [
          { categoryId: 'namaz', goalId: 'template-0', goalText: '5 намазов', completed: true, xpEarned: 999 },
          { categoryId: 'quran', goalId: 'template-0', goalText: '1 джуз', completed: true, xpEarned: 150 },
          { categoryId: 'sadaqa', goalId: 'template-4', goalText: 'Садака', completed: true, xpEarned: 500 },
          { categoryId: 'dhikr', goalId: 'template-9', goalText: 'Зикр', completed: true, xpEarned: 70 },
          { categoryId: 'ilm', goalId: 'template-4', goalText: 'Знания', completed: true, xpEarned: 200 },
          { categoryId: 'akhlaq', goalId: 'template-0', goalText: 'Ахлак', completed: true, xpEarned: 80 },
          { categoryId: 'unknown_cheat', goalId: 'x', goalText: 'Cheat', completed: true, xpEarned: 100 },
          { categoryId: 'fasting', goalId: 'x', goalText: 'Old', completed: true, xpEarned: 200 },
        ],
      },
    }, deps);

    assert.equal(res.success, true);
    // 80 + 150 + 100 + 70 + 60 + 80 = 540
    assert.equal(res.xpAdded, 540);
    assert.equal(db.getRaw(1001).xp, 540);
    assert.equal(db.getRaw(1001).earnedGoalXp[MONDAY_STR].namaz, true);
    assert.equal(db.getRaw(1001).earnedGoalXp[MONDAY_STR].unknown_cheat, undefined);
  });

  test('legacy-ключ в earnedGoalXp БД блокирует повторное начисление по каноническому ключу', async () => {
    const db = createFakeDb([
      makeBaseUser({
        earnedGoalXp: { [MONDAY_STR]: { prayer: true, charity: true } },
        dailyGoalRecords: {
          [MONDAY_STR]: [
            { categoryId: 'prayer', goalId: 'template-0', goalText: 'Old prayer', completed: true, xpEarned: 80 },
          ],
        },
      }),
    ]);
    const deps = { db, addContestXp: NOOP_CONTEST, now: MONDAY_NOW };

    const res = await updateUserProgress(1001, {
      syncVersion: 0,
      dailyGoalRecords: {
        [MONDAY_STR]: [
          { categoryId: 'namaz', goalId: 'template-0', goalText: '5 намазов', completed: true, xpEarned: 80 },
          { categoryId: 'sadaqa', goalId: 'template-0', goalText: 'Садака', completed: true, xpEarned: 80 },
          { categoryId: 'ilm', goalId: 'template-0', goalText: 'Хадис', completed: true, xpEarned: 30 },
        ],
      },
    }, deps);

    assert.equal(res.success, true);
    // namaz (prayer) и sadaqa (charity) заблокированы; засчитан только ilm (+30)
    assert.equal(res.xpAdded, 30);
    assert.equal(db.getRaw(1001).xp, 30);
  });

  test('повторный sync и удаление выполненной цели из массива не дают дублировать XP и не теряют запись', async () => {
    const db = createFakeDb([makeBaseUser()]);
    const deps = { db, addContestXp: NOOP_CONTEST, now: MONDAY_NOW };

    const first = await updateUserProgress(1001, {
      syncVersion: 0,
      dailyGoalRecords: {
        [MONDAY_STR]: [
          { categoryId: 'namaz', goalId: 'template-0', goalText: '5 намазов', completed: true, xpEarned: 80 },
        ],
      },
    }, deps);
    assert.equal(first.xpAdded, 80);

    // Второй sync присылает пустой массив за сегодня — зачтённая запись не должна потеряться
    const second = await updateUserProgress(1001, {
      syncVersion: 1,
      dailyGoalRecords: { [MONDAY_STR]: [] },
    }, deps);
    assert.equal(second.xpAdded, 0);
    assert.equal(db.getRaw(1001).dailyGoalRecords[MONDAY_STR].length, 1);
    assert.equal(db.getRaw(1001).dailyGoalRecords[MONDAY_STR][0].categoryId, 'namaz');

    // Третий sync снова шлёт ту же выполненную цель — XP = 0
    const third = await updateUserProgress(1001, {
      syncVersion: 2,
      dailyGoalRecords: {
        [MONDAY_STR]: [
          { categoryId: 'namaz', goalId: 'template-0', goalText: '5 намазов', completed: true, xpEarned: 80 },
        ],
      },
    }, deps);
    assert.equal(third.xpAdded, 0);
    assert.equal(db.getRaw(1001).xp, 80);
  });
});

describe('Антидубли XP и валидация источников прогресса', () => {
  test('дневной прогресс: снятие и повторная отметка, фейковые ключи и нафль-пост вне пн/чт', async () => {
    const db = createFakeDb([makeBaseUser()]);
    const depsTue = { db, addContestXp: NOOP_CONTEST, now: TUESDAY_NOW };

    // Вторник: fajr (+50), fasting во вторник (0 — не пн/чт), fakeTask (0), singleName (0)
    const r1 = await updateUserProgress(1001, {
      syncVersion: 0,
      basicProgress: {
        [TUESDAY_STR]: { fajr: true, fasting: true, fakeTask: true, singleName: true },
      },
    }, depsTue);
    assert.equal(r1.xpAdded, 50);

    // Снимаем fajr
    const r2 = await updateUserProgress(1001, {
      syncVersion: 1,
      basicProgress: { [TUESDAY_STR]: { fajr: false } },
    }, depsTue);
    assert.equal(r2.xpAdded, 0);

    // Ставим fajr снова в тот же день — антидубль earnedTasks блокирует повторное начисление
    const r3 = await updateUserProgress(1001, {
      syncVersion: 2,
      basicProgress: { [TUESDAY_STR]: { fajr: true } },
    }, depsTue);
    assert.equal(r3.xpAdded, 0);
    assert.equal(db.getRaw(1001).xp, 50);
  });

  test('нафль-пост в понедельник в базовой фазе начисляет 50 XP ровно один раз', async () => {
    const db = createFakeDb([makeBaseUser()]);
    const depsMon = { db, addContestXp: NOOP_CONTEST, now: MONDAY_NOW };

    const r1 = await updateUserProgress(1001, {
      syncVersion: 0,
      basicProgress: { [MONDAY_STR]: { fasting: true } },
    }, depsMon);
    assert.equal(r1.xpAdded, 50);

    const r2 = await updateUserProgress(1001, {
      syncVersion: 1,
      basicProgress: { [MONDAY_STR]: { fasting: true } },
    }, depsMon);
    assert.equal(r2.xpAdded, 0);
  });

  test('earnedTasbeehXp: повторный sync и неизвестный dhikrId не начисляют XP, валидный обновляет стрик', async () => {
    const db = createFakeDb([makeBaseUser()]);
    const deps = { db, addContestXp: NOOP_CONTEST, now: MONDAY_NOW };

    const r1 = await updateUserProgress(1001, {
      syncVersion: 0,
      tasbeehRecords: {
        [MONDAY_STR]: {
          counts: { subhanallah: 33, fake_dhikr: 999 },
          completedIds: ['subhanallah', 'fake_dhikr'],
          xpEarned: 999,
        },
      },
    }, deps);
    assert.equal(r1.xpAdded, 33);
    assert.equal(db.getRaw(1001).currentStreak, 1);
    assert.equal(db.getRaw(1001).lastActiveDate, MONDAY_STR);

    // Повторный sync того же зикра — 0 XP
    const r2 = await updateUserProgress(1001, {
      syncVersion: 1,
      tasbeehRecords: {
        [MONDAY_STR]: {
          counts: { subhanallah: 33 },
          completedIds: ['subhanallah'],
          xpEarned: 33,
        },
      },
    }, deps);
    assert.equal(r2.xpAdded, 0);
    assert.equal(db.getRaw(1001).xp, 33);
  });

  test('earnedJuzXpIds, memorizedNames и quranKhatams защищены от повторов, сброса и невалидных ID', async () => {
    const db = createFakeDb([makeBaseUser()]);
    const deps = { db, addContestXp: NOOP_CONTEST, now: MONDAY_NOW };

    // 1 валидный джуз (+150), 1 невалидный (31 -> игнор), 1 имя (+100), 1 невалидное (100 -> игнор), 1-й хатым (+1000)
    const r1 = await updateUserProgress(1001, {
      syncVersion: 0,
      earnedJuzXpIds: [1, 31, 0],
      memorizedNames: [5, 100, -1],
      quranKhatams: 1,
    }, deps);
    assert.equal(r1.xpAdded, 150 + 100 + 1000);
    assert.deepEqual(db.getRaw(1001).earnedJuzXpIds, [1]);
    assert.deepEqual(db.getRaw(1001).memorizedNames, [5]);
    assert.equal(db.getRaw(1001).quranKhatams, 1);

    // Попытка сбросить массивы и quranKhatams в 0
    const r2 = await updateUserProgress(1001, {
      syncVersion: 1,
      earnedJuzXpIds: [],
      memorizedNames: [],
      quranKhatams: 0,
    }, deps);
    assert.equal(r2.xpAdded, 0);
    assert.deepEqual(db.getRaw(1001).earnedJuzXpIds, [1]);
    assert.deepEqual(db.getRaw(1001).memorizedNames, [5]);
    assert.equal(db.getRaw(1001).quranKhatams, 1);

    // Повторная отправка тех же ID (включая строковый "1") и 2-й хатым — 0 XP
    const r3 = await updateUserProgress(1001, {
      syncVersion: 2,
      earnedJuzXpIds: ['1', 1],
      memorizedNames: ['5', 5],
      quranKhatams: 2,
    }, deps);
    assert.equal(r3.xpAdded, 0);
    assert.equal(db.getRaw(1001).quranKhatams, 2);
    assert.equal(db.getRaw(1001).xp, 1250);
  });
});

describe('syncVersion конфликты и защита от race conditions через withUserLock', () => {
  test('устаревший syncVersion возвращает conflict: true и не меняет БД', async () => {
    const db = createFakeDb([makeBaseUser({ syncVersion: 3, xp: 200 })]);
    const deps = { db, addContestXp: NOOP_CONTEST, now: MONDAY_NOW };

    const res = await updateUserProgress(1001, {
      syncVersion: 2,
      basicProgress: { [MONDAY_STR]: { fajr: true } },
    }, deps);

    assert.equal(res.success, false);
    assert.equal(res.conflict, true);
    assert.equal(res.syncVersion, 3);
    assert.equal(db.getRaw(1001).xp, 200);
    assert.equal(db.getRaw(1001).syncVersion, 3);
  });

  test('два конкурентных sync без syncVersion сериализуются withUserLock и не дают double XP', async () => {
    const db = createFakeDb([makeBaseUser()], { readDelayMs: 15 });
    const deps = { db, addContestXp: NOOP_CONTEST, now: MONDAY_NOW };

    const payload = {
      basicProgress: { [MONDAY_STR]: { fajr: true, dhuhr: true } },
      dailyGoalRecords: {
        [MONDAY_STR]: [
          { categoryId: 'namaz', goalId: 'template-0', goalText: '5 намазов', completed: true, xpEarned: 80 },
        ],
      },
    };

    const [r1, r2] = await Promise.all([
      updateUserProgress(1001, payload, deps),
      updateUserProgress(1001, payload, deps),
    ]);

    assert.equal(r1.success, true);
    assert.equal(r2.success, true);
    assert.equal(r1.xpAdded + r2.xpAdded, 180);
    assert.equal(db.getRaw(1001).xp, 180);
  });

  test('конкурентные updateUserProgress и addUserXP не затирают XP друг друга', async () => {
    const db = createFakeDb([makeBaseUser({ xp: 100 })], { readDelayMs: 15 });
    const deps = { db, addContestXp: NOOP_CONTEST, now: MONDAY_NOW };

    await Promise.all([
      updateUserProgress(1001, {
        syncVersion: 0,
        basicProgress: { [MONDAY_STR]: { fajr: true } },
      }, deps),
      addUserXP(1001, 100, 'referral bonus', deps),
    ]);

    // 100 (initial) + 50 (fajr) + 100 (referral) = 250
    assert.equal(db.getRaw(1001).xp, 250);
  });
});
