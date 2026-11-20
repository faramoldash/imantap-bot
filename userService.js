// userService.js
import { getDB } from './db.js';
import { addContestXp } from './services/contestService.js';
import {
  RAMADAN_START_DATE, PREPARATION_START_DATE,
  EID_AL_FITR_DATE, EID_AL_FITR_MS,
} from './config.js';
import { withUserLock } from './utils/userLock.js';

/**
 * ✅ ТАБЛИЦА НАЧИСЛЕНИЯ XP ЗА ЗАДАЧИ
 */
const XP_VALUES = {
  fajr: 50, duha: 30, dhuhr: 50, asr: 50, maghrib: 50, isha: 50,
  taraweeh: 100, tahajjud: 50, witr: 50, eidPrayer: 200,
  fasting: 200, quranRead: 50, morningDhikr: 30, eveningDhikr: 30,
  salawat: 50, hadith: 30, charity: 50, names99: 50, lessons: 30, book: 30,
  singleName: 100
};

// ─── ДОПУСТИМЫЕ XP ЗА КАТЕГОРИИ ЦЕЛЕЙ (v2) ───
// Синхронизировано с GoalCategoryId и GOAL_CATEGORIES (imantap mini app/constants.ts)
const GOAL_CATEGORY_MAX_XP = {
  namaz:  80,
  quran:  150,
  sadaqa: 100,
  dhikr:  70,
  ilm:    60,
  akhlaq: 80,
};

// Обратная совместимость со старыми ключами категорий в БД
const LEGACY_GOAL_CATEGORY_MAP = {
  prayer:  'namaz',
  charity: 'sadaqa',
  selfdev: 'ilm',
};

const TASBEEH_XP = {
  subhanallah: 33,
  alhamdulillah: 33,
  allahuakbar: 33,
  astaghfirullah: 100,
  lailaha: 100,
  salavat: 100,
};

function normalizeGoalCategoryId(categoryId) {
  if (typeof categoryId !== 'string') return null;
  const trimmed = categoryId.trim();
  if (!trimmed) return null;
  if (Object.prototype.hasOwnProperty.call(GOAL_CATEGORY_MAX_XP, trimmed)) {
    return trimmed;
  }
  if (Object.prototype.hasOwnProperty.call(LEGACY_GOAL_CATEGORY_MAP, trimmed)) {
    return LEGACY_GOAL_CATEGORY_MAP[trimmed];
  }
  return null;
}

function addDaysToIsoDate(startDateStr, offsetDays) {
  const [y, m, d] = startDateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

function isValidDailyTaskKey(taskKey) {
  return taskKey !== 'singleName' && Object.prototype.hasOwnProperty.call(XP_VALUES, taskKey);
}

/**
 * #B3 FIX: Получить «сегодня» в таймзоне пользователя.
 * Если timezone не задан — берём 'Asia/Almaty' (UTC+5, Казахстан).
 * Если timezone невалиден — тоже фолбэк на 'Asia/Almaty'.
 */
// Проверяет, является ли календарная дата dateStr (YYYY-MM-DD) понедельником или четвергом.
// Используется для серверной валидации нафль-оразы вне Рамадана.
// День недели календарной даты не зависит от часового пояса, поэтому считаем по UTC-календарю
// без риска сдвига в UTC+13/+14 или RangeError при невалидной таймзоне.
function isMondayOrThursday(dateStr, _timezone) {
  if (typeof dateStr !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() !== month - 1 ||
    utcDate.getUTCDate() !== day
  ) {
    return false;
  }
  const dow = utcDate.getUTCDay();
  return dow === 1 || dow === 4;
}

function getTodayStr(timezone, nowDate = new Date()) {
  const tz = timezone || 'Asia/Almaty';
  try {
    return nowDate.toLocaleDateString('en-CA', { timeZone: tz });
  } catch {
    return nowDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Almaty' });
  }
}

async function generateUniquePromoCode(usersCollection) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const exists = await usersCollection.findOne({ promoCode: code });
    if (!exists) return code;
  }
  return Date.now().toString(36).toUpperCase().slice(-6);
}

/**
 * Создать или получить пользователя
 */
async function getOrCreateUser(userId, username = null) {
  const db = getDB();
  const users = db.collection('users');
  let user = await users.findOne({ userId });

  if (!user) {
    const promoCode = await generateUniquePromoCode(users);
    const newUser = {
      userId,
      username: username ? `@${username}` : null,
      promoCode,
      invitedCount: 0,
      name: null,
      phoneNumber: null,
      location: { city: null, country: null, latitude: null, longitude: null, timezone: null },
      prayerTimes: { fajr: null, sunrise: null, dhuhr: null, asr: null, maghrib: null, isha: null, lastUpdated: null },
      notificationSettings: { ramadanReminders: true, reminderMinutesBefore: 30 },
      referredBy: null,
      usedPromoCode: null,
      paymentStatus: 'unpaid',
      paidAmount: null,
      hasDiscount: false,
      receiptPhotoId: null,
      receiptMessageId: null,
      paymentDate: null,
      subscriptionExpiresAt: null,
      subscriptionNotified3Days: false,
      subscriptionNotified1Day: false,
      accessType: null,
      demoExpiresAt: null,
      progress: {},
      preparationProgress: {},
      basicProgress: {},
      memorizedNames: [],
      completedJuzs: [],
      earnedJuzXpIds: [],
      quranKhatams: 0,
      completedTasks: [],
      deletedPredefinedTasks: [],
      customTasks: [],
      quranGoal: 30,
      dailyQuranGoal: 5,
      dailyCharityGoal: 1000,
      language: 'kk',
      xp: 0,
      unlockedBadges: [],
      hasRedeemedReferral: false,
      // ✅ ПОЛЯ Мақсаттар v2
      dailyGoalRecords: {},      // { '2026-03-01': [ DailyGoalRecord, ... ] }
      goalCustomItems: {},        // { namaz: [ CustomGoalItem, ... ] }
      // FIX #B1: goalStreaks хранит объекты { current, longest, lastCompletedDate }
      goalStreaks: {},             // { namaz: { current:3, longest:5, lastCompletedDate:'2026-03-01' }, ... }
      earnedGoalXp: {},           // { '2026-03-01': { namaz: true, quran: true } }
      tasbeehRecords: {},
      earnedTasbeehXp: {},
      tasbeehTotals: {},
      syncVersion: 0,
      onboardingCompleted: false,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await users.insertOne(newUser);
    console.log(`✅ Создан новый пользователь: ${userId}`);
    user = newUser;
  }
  return user;
}

async function getUserById(userId) {
  try {
    const db = getDB();
    return await db.collection('users').findOne({ userId: parseInt(userId) });
  } catch (error) {
    console.error('❌ Ошибка в getUserById:', error);
    throw error;
  }
}

async function getUserByPromoCode(promoCode) {
  try {
    const db = getDB();
    return await db.collection('users').findOne({ promoCode: promoCode.toUpperCase() });
  } catch (error) {
    console.error('❌ Ошибка в getUserByPromoCode:', error);
    throw error;
  }
}

async function incrementReferralCount(promoCode) {
  try {
    const db = getDB();
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ promoCode: promoCode.toUpperCase() });
    const result = await usersCollection.updateOne(
      { promoCode: promoCode.toUpperCase() },
      { $inc: { invitedCount: 1 }, $set: { updatedAt: new Date() } }
    );
    if (result.modifiedCount > 0 && user) {
      await checkAndUnlockBadges(user.userId);
      return true;
    }
    return false;
  } catch (error) {
    console.error('❌ incrementReferralCount:', error);
    throw error;
  }
}

/**
 * Обновить полный прогресс пользователя (sync endpoint)
 * Обёрнуто в _withUserLock — конкурентные запросы одного userId выполняются строго по очереди.
 */
async function updateUserProgress(userId, progressData, deps = {}) {
  return withUserLock(userId, () => _updateUserProgressLocked(userId, progressData, deps));
}

async function _updateUserProgressLocked(userId, progressData, deps = {}) {
  try {
    const db = deps.db || getDB();
    const addContestXpFn = deps.addContestXp || addContestXp;
    const usersCollection = db.collection('users');

    const oldUser = await usersCollection.findOne({ userId: parseInt(userId) });
    if (!oldUser) { console.error('❌ Пользователь не найден:', userId); return false; }

    // Клиент отправляет версию последней полученной копии. Если за это время
    // данные уже менялись на другом устройстве, не затираем их целым snapshot.
    const currentSyncVersion = Number.isInteger(oldUser.syncVersion) ? oldUser.syncVersion : 0;
    const expectedSyncVersion = Number.isInteger(progressData.syncVersion)
      ? progressData.syncVersion
      : null;
    if (expectedSyncVersion !== null && expectedSyncVersion !== currentSyncVersion) {
      return { success: false, conflict: true, syncVersion: currentSyncVersion };
    }

    // FIX #B3: используем безопасную функцию getTodayStr
    const userTimezone = oldUser.location?.timezone || 'Asia/Almaty';
    const now = deps.now ? new Date(deps.now) : new Date();
    const todayDateStr = getTodayStr(userTimezone, now);

    let xpToAdd = 0;
    const earnedTasksFromDB = oldUser.earnedTasks || {};
    const todayEarned = [...(earnedTasksFromDB[todayDateStr] || [])];
    const streakMultiplier = Math.min(1 + ((oldUser.currentStreak || 0) * 0.1), 3.0);

    // ─── XP за Ramadan прогресс ───
    if (progressData.progress) {
      const oldProgress = oldUser.progress || {};
      for (const day in progressData.progress) {
        const dayNum = parseInt(day, 10);
        if (!Number.isInteger(dayNum) || dayNum < 1) continue;
        const newDayData = progressData.progress[day];
        if (!newDayData || typeof newDayData !== 'object') continue;
        const oldDayData = oldProgress[day] || {};
        const dayDateStr = addDaysToIsoDate(RAMADAN_START_DATE, dayNum - 1);
        if (dayDateStr === todayDateStr) {
          for (const taskKey in newDayData) {
            if (!isValidDailyTaskKey(taskKey)) continue;
            if (newDayData[taskKey] === true && !oldDayData[taskKey] && !todayEarned.includes(taskKey)) {
              const baseXP = XP_VALUES[taskKey];
              xpToAdd += Math.floor(baseXP * streakMultiplier);
              todayEarned.push(taskKey);
              console.log(`✅ +${Math.floor(baseXP * streakMultiplier)} XP за ${taskKey}`);
            }
          }
        }
      }
    }

    // ─── XP за Preparation прогресс ───
    if (progressData.preparationProgress) {
      const oldPrep = oldUser.preparationProgress || {};
      for (const day in progressData.preparationProgress) {
        const dayNum = parseInt(day, 10);
        if (!Number.isInteger(dayNum) || dayNum < 1) continue;
        const newDayData = progressData.preparationProgress[day];
        if (!newDayData || typeof newDayData !== 'object') continue;
        const oldDayData = oldPrep[day] || {};
        const dayDateStr = addDaysToIsoDate(PREPARATION_START_DATE, dayNum - 1);
        if (dayDateStr === todayDateStr) {
          for (const taskKey in newDayData) {
            if (!isValidDailyTaskKey(taskKey)) continue;
            if (newDayData[taskKey] === true && !oldDayData[taskKey] && !todayEarned.includes(taskKey)) {
              let baseXP;
              if (taskKey === 'fasting') {
                if (!isMondayOrThursday(dayDateStr, userTimezone)) {
                  console.log(`🛡️ Блок: ораза вне пн/чт в фазе подготовки (${dayDateStr})`);
                  continue;
                }
                baseXP = 50;
              } else {
                baseXP = XP_VALUES[taskKey];
              }
              xpToAdd += Math.floor(baseXP * streakMultiplier);
              todayEarned.push(taskKey);
            }
          }
        }
      }
    }

    // ─── XP за Basic прогресс ───
    if (progressData.basicProgress) {
      const oldBasic = oldUser.basicProgress || {};
      for (const dateKey in progressData.basicProgress) {
        if (dateKey === todayDateStr) {
          const newDayData = progressData.basicProgress[dateKey];
          if (!newDayData || typeof newDayData !== 'object') continue;
          const oldDayData = oldBasic[dateKey] || {};
          for (const taskKey in newDayData) {
            if (!isValidDailyTaskKey(taskKey)) continue;
            if (newDayData[taskKey] === true && !oldDayData[taskKey] && !todayEarned.includes(taskKey)) {
              let baseXP;
              if (taskKey === 'fasting') {
                if (dateKey === EID_AL_FITR_DATE || !isMondayOrThursday(dateKey, userTimezone)) {
                  console.log(`🛡️ Блок: ораза вне пн/чт или в день Айта в базовой фазе (${dateKey})`);
                  continue;
                }
                baseXP = 50;
              } else {
                baseXP = XP_VALUES[taskKey];
              }
              xpToAdd += Math.floor(baseXP * streakMultiplier);
              todayEarned.push(taskKey);
            }
          }
        }
      }
    }

    // ─── ✅ XP за dailyGoalRecords (v2) — ЕДИНСТВЕННОЕ место начисления ───
    // FIX #B2: убрана дублирующая логика earnedGoalXp ниже — всё в одном месте
    const mergedEarnedGoalXp = { ...(oldUser.earnedGoalXp || {}) };
    if (progressData.dailyGoalRecords) {
      const todayEarnedGoals = { ...(mergedEarnedGoalXp[todayDateStr] || {}) };
      // Обратная совместимость: старые legacy-ключи в БД блокируют повторное начисление по каноническим
      for (const [legacyKey, canonicalKey] of Object.entries(LEGACY_GOAL_CATEGORY_MAP)) {
        if (todayEarnedGoals[legacyKey]) {
          todayEarnedGoals[canonicalKey] = true;
        }
      }

      const incomingToday = progressData.dailyGoalRecords[todayDateStr];
      if (Array.isArray(incomingToday)) {
        for (const record of incomingToday) {
          if (!record || typeof record !== 'object') continue;
          const { categoryId, completed, xpEarned } = record;
          const canonicalCategoryId = normalizeGoalCategoryId(categoryId);

          // Защита 0: только допустимые категории Goals v2 (и legacy-алиасы)
          if (!canonicalCategoryId) {
            console.log(`🛡️ Блок: неизвестная категория цели ${categoryId}`);
            continue;
          }
          // Защита 1: категория уже зачтена сегодня
          if (todayEarnedGoals[canonicalCategoryId]) {
            console.log(`🛡️ Блок: повторное начисление XP за ${canonicalCategoryId} — уже зачтено сегодня`);
            continue;
          }
          // Защита 2: только completed
          if (!completed) continue;
          // Защита 3: maxXP по категории
          const maxXp = GOAL_CATEGORY_MAX_XP[canonicalCategoryId];
          const safeXp = Math.min(Math.max(parseInt(xpEarned, 10) || 0, 0), maxXp);
          if (safeXp <= 0) continue;

          const finalXp = Math.floor(safeXp * streakMultiplier);
          xpToAdd += finalXp;
          todayEarnedGoals[canonicalCategoryId] = true;
          console.log(`🎯 +${finalXp} XP за цель категории ${canonicalCategoryId} (x${streakMultiplier.toFixed(2)})`);
        }
      }
      // Записываем обновлённый earnedGoalXp один раз
      mergedEarnedGoalXp[todayDateStr] = todayEarnedGoals;
    }

    // ─── ОБЪЕКТ ОБНОВЛЕНИЯ ───
    const updateFields = { updatedAt: now };
    const shouldUpdate = (value) => {
      if (value === undefined || value === null) return false;
      if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return false;
      return true;
    };

    // earnedTasks (старая система)
    const newEarnedTasks = { ...earnedTasksFromDB };
    newEarnedTasks[todayDateStr] = todayEarned;
    updateFields.earnedTasks = newEarnedTasks;

    // FIX #B2: earnedGoalXp записывается ровно один раз — из mergedEarnedGoalXp выше
    if (progressData.dailyGoalRecords !== undefined) {
      updateFields.earnedGoalXp = mergedEarnedGoalXp;
    }

    if (progressData.name !== undefined) updateFields.name = progressData.name;
    if (progressData.username !== undefined) updateFields.username = progressData.username;
    if (progressData.photoUrl !== undefined) updateFields.photoUrl = progressData.photoUrl;
    if (progressData.registrationDate !== undefined) updateFields.registrationDate = progressData.registrationDate;
    if (shouldUpdate(progressData.progress)) updateFields.progress = progressData.progress;
    if (shouldUpdate(progressData.preparationProgress)) updateFields.preparationProgress = progressData.preparationProgress;
    if (shouldUpdate(progressData.basicProgress)) updateFields.basicProgress = progressData.basicProgress;

    // Стрик-множитель для духовных практик (как и для намаза)
    const streakMultiplierSpiritual = streakMultiplier;

    // memorizedNames — только растёт, валидные ID 1..99
    if (progressData.memorizedNames !== undefined) {
      const oldMemorized = (oldUser.memorizedNames || [])
        .map(id => Number(id))
        .filter(id => Number.isInteger(id) && id >= 1 && id <= 99);
      const incoming = Array.isArray(progressData.memorizedNames)
        ? progressData.memorizedNames
            .map(id => Number(id))
            .filter(id => Number.isInteger(id) && id >= 1 && id <= 99)
        : [];
      const merged = [...new Set([...oldMemorized, ...incoming])];
      updateFields.memorizedNames = merged;
      const newlyMemorized = merged.filter(id => !oldMemorized.includes(id));
      if (newlyMemorized.length > 0) {
        const nameXp = Math.floor(newlyMemorized.length * XP_VALUES.singleName * streakMultiplierSpiritual);
        xpToAdd += nameXp;
        console.log(`📿 +${nameXp} XP за новые имена (x${streakMultiplierSpiritual.toFixed(2)})`);
      }
    }

    if (progressData.completedJuzs !== undefined) updateFields.completedJuzs = progressData.completedJuzs;

    if (progressData.earnedJuzXpIds !== undefined) {
      const oldEarned = (oldUser.earnedJuzXpIds || [])
        .map(id => Number(id))
        .filter(id => Number.isInteger(id) && id >= 1 && id <= 30);
      const incoming = Array.isArray(progressData.earnedJuzXpIds)
        ? progressData.earnedJuzXpIds
            .map(id => Number(id))
            .filter(id => Number.isInteger(id) && id >= 1 && id <= 30)
        : [];
      const merged = [...new Set([...oldEarned, ...incoming])];
      updateFields.earnedJuzXpIds = merged;
      const newlyEarned = merged.filter(id => !oldEarned.includes(id));
      if (newlyEarned.length > 0) {
        const juzXp = Math.floor(newlyEarned.length * 150 * streakMultiplierSpiritual);
        xpToAdd += juzXp;
        console.log(`📖 +${juzXp} XP за новые джузы (x${streakMultiplierSpiritual.toFixed(2)})`);
      }
    }

    if (progressData.quranKhatams !== undefined) {
      const oldKhatams = oldUser.quranKhatams || 0;
      const parsedNewKhatams = Math.max(0, parseInt(progressData.quranKhatams, 10) || 0);
      const safeKhatams = Math.max(oldKhatams, parsedNewKhatams);
      if (safeKhatams > oldKhatams && oldKhatams === 0 && oldUser.earnedFirstKhatamXp !== true) {
        const khatamXp = Math.floor(1000 * streakMultiplierSpiritual);
        xpToAdd += khatamXp;
        updateFields.earnedFirstKhatamXp = true;
        console.log(`🕋 +${khatamXp} XP за первый хатым! (x${streakMultiplierSpiritual.toFixed(2)})`);
      }
      updateFields.quranKhatams = safeKhatams;
    }

    if (progressData.completedTasks !== undefined) updateFields.completedTasks = progressData.completedTasks;
    if (progressData.deletedPredefinedTasks !== undefined) updateFields.deletedPredefinedTasks = progressData.deletedPredefinedTasks;
    if (progressData.customTasks !== undefined) updateFields.customTasks = progressData.customTasks;
    if (progressData.quranGoal !== undefined) updateFields.quranGoal = progressData.quranGoal;
    if (progressData.dailyQuranGoal !== undefined) updateFields.dailyQuranGoal = progressData.dailyQuranGoal;
    if (progressData.dailyCharityGoal !== undefined) updateFields.dailyCharityGoal = progressData.dailyCharityGoal;
    if (progressData.language !== undefined) updateFields.language = progressData.language;
    // hasRedeemedReferral управляется только сервером при применении промокода/реферальной ссылки —
    // клиентский sync не должен сбрасывать или подменять этот флаг.
    if (progressData.unlockedBadges !== undefined) updateFields.unlockedBadges = progressData.unlockedBadges;

    // ─── НОВЫЕ ПОЛЯ v2 ───

    // dailyGoalRecords: принимаем историю, защищаем зачтённые записи
    if (progressData.dailyGoalRecords !== undefined) {
      const oldRecords = oldUser.dailyGoalRecords || {};
      const incoming = progressData.dailyGoalRecords || {};
      // earnedGoalXp уже обновлён выше в mergedEarnedGoalXp
      const earnedGoalXpNow = mergedEarnedGoalXp;

      const merged = { ...oldRecords };
      for (const dateKey in incoming) {
        const incomingArr = incoming[dateKey];
        if (!Array.isArray(incomingArr)) continue;

        if (dateKey !== todayDateStr) {
          // Прошлые дни — принимаем только если не было в БД
          if (!merged[dateKey]) merged[dateKey] = incomingArr;
        } else {
          // Сегодня: защита записей, за которые уже начислен XP
          const earnedToday = earnedGoalXpNow[todayDateStr] || {};
          const existingToday = oldRecords[todayDateStr] || [];
          const seenCanonical = new Set();
          const protectedRecords = incomingArr
            .filter(rec => rec && typeof rec === 'object')
            .map(rec => {
              const canonicalId = normalizeGoalCategoryId(rec.categoryId) || rec.categoryId;
              seenCanonical.add(canonicalId);
              if (earnedToday[canonicalId] || earnedToday[rec.categoryId]) {
                return existingToday.find(r =>
                  r && (normalizeGoalCategoryId(r.categoryId) || r.categoryId) === canonicalId
                ) || rec;
              }
              return rec;
            });
          // Сохраняем ранее зачтённые сегодня цели, даже если клиент прислал неполный список
          for (const existingRec of existingToday) {
            if (!existingRec || typeof existingRec !== 'object') continue;
            const canonicalId = normalizeGoalCategoryId(existingRec.categoryId) || existingRec.categoryId;
            if ((earnedToday[canonicalId] || earnedToday[existingRec.categoryId]) && !seenCanonical.has(canonicalId)) {
              protectedRecords.push(existingRec);
              seenCanonical.add(canonicalId);
            }
          }
          merged[todayDateStr] = protectedRecords;
        }
      }
      updateFields.dailyGoalRecords = merged;
    }

    // goalCustomItems — принимаем как есть
    if (progressData.goalCustomItems !== undefined) {
      updateFields.goalCustomItems = progressData.goalCustomItems || {};
    }

    // FIX #B1: goalStreaks — фронт присылает объекты { current, longest, lastCompletedDate }.
    // Бэкенд НЕ перезаписывает streak если current фронта < current в БД (защита от откатов).
    if (progressData.goalStreaks !== undefined) {
      const oldStreaks = oldUser.goalStreaks || {};
      const incoming = progressData.goalStreaks || {};
      const mergedStreaks = { ...oldStreaks };

      for (const rawCatId in incoming) {
        const canonicalCatId = normalizeGoalCategoryId(rawCatId) || rawCatId;
        const inc = incoming[rawCatId];
        const legacyKey = Object.keys(LEGACY_GOAL_CATEGORY_MAP).find(k => LEGACY_GOAL_CATEGORY_MAP[k] === canonicalCatId);
        const old = oldStreaks[canonicalCatId] ?? oldStreaks[rawCatId] ?? (legacyKey ? oldStreaks[legacyKey] : undefined);

        // Поддержка обоих форматов: число (legacy) и объект (v2)
        const incCurrent  = (typeof inc === 'object' && inc !== null) ? (parseInt(inc.current, 10)  || 0) : (parseInt(inc, 10) || 0);
        const incLongest  = (typeof inc === 'object' && inc !== null) ? (parseInt(inc.longest, 10)  || 0) : incCurrent;
        const incLastDate = (typeof inc === 'object' && inc !== null) ? (inc.lastCompletedDate  || '') : '';

        const oldCurrent  = (typeof old === 'object' && old !== null) ? (parseInt(old.current, 10)  || 0) : (parseInt(old, 10) || 0);
        const oldLongest  = (typeof old === 'object' && old !== null) ? (parseInt(old.longest, 10)  || 0) : oldCurrent;

        // Блокируем прыжок current больше чем +1 за раз (защита от накруток)
        const safeCurrent = incCurrent <= oldCurrent + 1 ? Math.max(0, incCurrent) : oldCurrent;
        const safeLongest = Math.max(oldLongest, safeCurrent, Math.max(0, incLongest));

        mergedStreaks[canonicalCatId] = {
          current: safeCurrent,
          longest: safeLongest,
          lastCompletedDate: incLastDate || ((typeof old === 'object' && old !== null) ? old.lastCompletedDate : '') || '',
        };
      }
      updateFields.goalStreaks = mergedStreaks;
    }

    // ─── tasbeehRecords: сохранить и начислить XP за выполненные зікіры ───
    if (progressData.tasbeehRecords !== undefined) {
      const oldTasbeeh = oldUser.tasbeehRecords || {};
      const incoming   = progressData.tasbeehRecords || {};
      const earnedTasbeehXp = { ...(oldUser.earnedTasbeehXp || {}) };

      const merged = { ...oldTasbeeh };
      for (const dateKey in incoming) {
        const dayRecord = incoming[dateKey];
        if (!dayRecord || typeof dayRecord !== 'object') continue;

        merged[dateKey] = dayRecord;

        if (dateKey === todayDateStr) {
          const todayEarnedDhikrs = [...(earnedTasbeehXp[todayDateStr] || [])];
          const completedIds = Array.isArray(dayRecord.completedIds) ? dayRecord.completedIds : [];

          for (const dhikrId of completedIds) {
            if (!Object.prototype.hasOwnProperty.call(TASBEEH_XP, dhikrId)) continue;
            if (!todayEarnedDhikrs.includes(dhikrId)) {
              const dhikrXp = TASBEEH_XP[dhikrId];
              xpToAdd += dhikrXp;
              todayEarnedDhikrs.push(dhikrId);
              console.log(`📿 +${dhikrXp} XP за зікір ${dhikrId}`);
            }
          }
          earnedTasbeehXp[todayDateStr] = todayEarnedDhikrs;
        }
      }

      updateFields.tasbeehRecords   = merged;
      updateFields.earnedTasbeehXp  = earnedTasbeehXp;
      if (progressData.tasbeehTotals) {
        const oldTotals = oldUser.tasbeehTotals || {};
        const incomingTotals = progressData.tasbeehTotals || {};
        const mergedTotals = { ...oldTotals };
        for (const dhikrId in incomingTotals) {
          // берём максимум — защита от случайного уменьшения
          mergedTotals[dhikrId] = Math.max(
            oldTotals[dhikrId] || 0,
            incomingTotals[dhikrId] || 0
          );
        }
        updateFields.tasbeehTotals = mergedTotals;
      }
    }

    // ─── ОБНОВЛЕНИЕ СТРИКА (после всех источников XP: намаз, цели, Коран, имена, тасбих) ───
    const lastActiveDate = oldUser.lastActiveDate || '';
    const yesterdayStr = getTodayStr(userTimezone, new Date(now.getTime() - 86400000));
    let newStreak = oldUser.currentStreak || 0;
    const hasActivityToday = xpToAdd > 0;
    if (hasActivityToday) {
      if (lastActiveDate === yesterdayStr) newStreak += 1;
      else if (lastActiveDate !== todayDateStr) newStreak = 1;
    }
    const longestStreak = Math.max(oldUser.longestStreak || 0, newStreak);

    // Глобальный стрик
    if (hasActivityToday) {
      updateFields.currentStreak = newStreak;
      updateFields.longestStreak = longestStreak;
      updateFields.lastActiveDate = todayDateStr;
    }

    // XP начисляем атомарно через $inc, чтобы конкурентные $inc (рефералы/бонусы/Шавваль)
    // не могли быть затёрты read-modify-write.
    const incFields = { syncVersion: 1 };
    if (xpToAdd > 0) {
      incFields.xp = xpToAdd;
    }

    const versionFilter = currentSyncVersion === 0
      ? { $or: [{ syncVersion: 0 }, { syncVersion: { $exists: false } }] }
      : { syncVersion: currentSyncVersion };
    const result = await usersCollection.updateOne(
      { userId: parseInt(userId), ...versionFilter },
      { $set: updateFields, $inc: incFields }
    );

    // Защита на случай обновления документа другим процессом между read и write.
    if (result.matchedCount === 0) {
      const latest = await usersCollection.findOne({ userId: parseInt(userId) }, { projection: { syncVersion: 1 } });
      return { success: false, conflict: true, syncVersion: latest?.syncVersion || 0 };
    }

    if (result.modifiedCount > 0 || xpToAdd > 0) {
      console.log(`✅ Прогресс обновлен для userId: ${userId}, начислено XP: ${xpToAdd}`);
      if (xpToAdd > 0) {
        addContestXpFn(userId, xpToAdd).catch(err =>
          console.error(`❌ addContestXp error for ${userId}:`, err)
        );
      }
      const currentStreak = hasActivityToday ? newStreak : (oldUser.currentStreak || 0);
      const effectiveMultiplier = Math.min(1 + (currentStreak * 0.1), 3.0);
      return { success: true, xpAdded: xpToAdd, streakMultiplier: xpToAdd > 0 ? effectiveMultiplier : 1.0, currentStreak, syncVersion: currentSyncVersion + 1 };
    }
    return { success: true, xpAdded: 0, streakMultiplier: 1.0, currentStreak: oldUser.currentStreak || 0, syncVersion: currentSyncVersion + 1 };
  } catch (error) {
    console.error('❌ updateUserProgress ошибка:', error);
    throw error;
  }
}

/**
 * Получить полные данные для Mini App
 */
async function getUserFullData(userId, deps = {}) {
  try {
    const db = deps.db || getDB();
    const user = await db.collection('users').findOne({ userId: parseInt(userId, 10) });
    if (!user) return null;

    const now = deps.now ? new Date(deps.now) : new Date();
    const subExpires = user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt) : null;
    const hasValidSubExpires = subExpires && !Number.isNaN(subExpires.getTime());

    return {
      userId: user.userId,
      syncVersion: Number.isInteger(user.syncVersion) ? user.syncVersion : 0,
      username: user.username,
      promoCode: user.promoCode,
      invitedCount: user.invitedCount,
      name: user.name,
      photoUrl: user.photoUrl,
      startDate: user.startDate,
      registrationDate: user.createdAt || user.registrationDate,
      paymentStatus: user.paymentStatus || 'unpaid',
      accessType: user.accessType || null,
      demoExpiresAt: user.demoExpiresAt || null,
      progress: user.progress || {},
      preparationProgress: user.preparationProgress || {},
      basicProgress: user.basicProgress || {},
      memorizedNames: user.memorizedNames || [],
      completedJuzs: user.completedJuzs || [],
      earnedJuzXpIds: user.earnedJuzXpIds || [],
      quranKhatams: user.quranKhatams || 0,
      completedTasks: user.completedTasks || [],
      deletedPredefinedTasks: user.deletedPredefinedTasks || [],
      customTasks: user.customTasks || [],
      quranGoal: user.quranGoal || 30,
      dailyQuranGoal: user.dailyQuranGoal || 4,
      dailyCharityGoal: user.dailyCharityGoal || 100,
      language: user.language || 'kk',
      xp: user.xp || 0,
      referralCount: user.invitedCount,
      myPromoCode: user.promoCode,
      hasRedeemedReferral: user.hasRedeemedReferral || false,
      unlockedBadges: user.unlockedBadges || [],
      currentStreak: user.currentStreak || 0,
      longestStreak: user.longestStreak || 0,
      lastActiveDate: user.lastActiveDate || '',
      subscriptionExpiresAt: hasValidSubExpires ? subExpires.toISOString() : null,
      daysLeft: hasValidSubExpires
        ? Math.ceil((subExpires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        : null,
      // ✅ ПОЛЯ v2
      dailyGoalRecords: user.dailyGoalRecords || {},
      goalCustomItems: user.goalCustomItems || {},
      goalStreaks: user.goalStreaks || {},
      tasbeehRecords: user.tasbeehRecords || {},
      tasbeehTotals: user.tasbeehTotals || {},
      // ✅ Намаз уақыттары
      prayerTimes: user.prayerTimes || null,
      // ✅ Шаввал
      shawwalFasts: user.shawwalFasts || 0,
      shawwalDates: user.shawwalDates || [],

    };
  } catch (error) {
    console.error('❌ getUserFullData ошибка:', error);
    throw error;
  }
}

// =====================================================
// 🔐 ФУНКЦИИ ДЛЯ ОНБОРДИНГА И ОПЛАТЫ
// =====================================================

async function updateUserOnboarding(userId, data) {
  const db = getDB();
  const users = db.collection('users');
  const result = await users.updateOne({ userId }, { $set: { ...data, updatedAt: new Date() } });
  return result.modifiedCount > 0;
}

/**
 * Извлекает документ из результата collection.findOneAndUpdate.
 * В mongodb@5.9.2 findOneAndUpdate возвращает ModifyResult `{ value, ok, lastErrorObject }`,
 * где `value` равен `null`, если документ не найден.
 * Также безопасно поддерживает прямой возврат документа (mongodb@6+ / includeResultMetadata: false).
 */
function unwrapModifyResult(result) {
  if (!result) return null;
  if (typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'value')) {
    return result.value ?? null;
  }
  return result;
}

async function checkPromoCode(promoCode, userId, deps = {}) {
  const normalizedCode = typeof promoCode === 'string' ? promoCode.trim().toUpperCase() : '';
  if (!normalizedCode) return { valid: false, reason: 'not_found' };

  const db = deps.db || getDB();
  const users = db.collection('users');
  const uid = parseInt(userId, 10);

  const owner = await users.findOne({ promoCode: normalizedCode });
  if (!owner) return { valid: false, reason: 'not_found' };
  if (Number(owner.userId) === uid) return { valid: false, reason: 'own_code' };
  if (owner.paymentStatus !== 'paid') return { valid: false, reason: 'owner_not_paid' };

  if (Number.isInteger(uid)) {
    const currentUser = await users.findOne(
      { userId: uid },
      { projection: { hasRedeemedReferral: 1, usedPromoCode: 1, referredBy: 1 } }
    );
    if (currentUser && (currentUser.hasRedeemedReferral || currentUser.usedPromoCode || currentUser.referredBy)) {
      return { valid: false, reason: 'already_redeemed' };
    }
  }

  return { valid: true, owner };
}

/**
 * Атомарно привязывает реферальный код / промокод к пользователю.
 * Защищает от самореферала, повторного ввода и race condition.
 */
async function redeemReferralCode(userId, promoCode, {
  source = 'promo',
  requirePaidOwner = true,
  paidAmount = undefined,
  db = null,
} = {}) {
  const uid = parseInt(userId, 10);
  const normalizedCode = typeof promoCode === 'string' ? promoCode.trim().toUpperCase() : '';
  if (!Number.isInteger(uid) || !normalizedCode) {
    return { success: false, reason: 'not_found' };
  }

  const database = db || getDB();
  const users = database.collection('users');

  const owner = await users.findOne({ promoCode: normalizedCode });
  if (!owner) return { success: false, reason: 'not_found' };
  if (Number(owner.userId) === uid) return { success: false, reason: 'own_code' };
  if (requirePaidOwner && owner.paymentStatus !== 'paid') {
    return { success: false, reason: 'owner_not_paid' };
  }

  const updateSet = {
    hasDiscount: true,
    hasRedeemedReferral: true,
    updatedAt: new Date(),
  };
  if (source === 'link') {
    updateSet.referredBy = normalizedCode;
  } else {
    updateSet.usedPromoCode = normalizedCode;
  }
  if (paidAmount !== undefined) {
    updateSet.paidAmount = paidAmount;
  }

  const modifyResult = await users.findOneAndUpdate(
    {
      userId: uid,
      hasRedeemedReferral: { $ne: true },
      referredBy: null,
      usedPromoCode: null,
    },
    { $set: updateSet },
    { returnDocument: 'after' }
  );

  const updatedUser = unwrapModifyResult(modifyResult);
  if (!updatedUser) {
    return { success: false, reason: 'already_redeemed' };
  }

  return { success: true, owner, user: updatedUser, code: normalizedCode };
}

/**
 * Реферальная статистика текущего авторизованного пользователя.
 * Если передан promoCode, проверяет, что он принадлежит этому пользователю.
 */
async function getReferralStats(userId, { promoCode = null, db = null } = {}) {
  const uid = parseInt(userId, 10);
  if (!Number.isInteger(uid)) {
    return { ok: false, status: 400, error: 'Invalid userId' };
  }

  const database = db || getDB();
  const users = database.collection('users');
  const user = await users.findOne(
    { userId: uid },
    {
      projection: {
        userId: 1,
        promoCode: 1,
        invitedCount: 1,
        hasRedeemedReferral: 1,
        referredBy: 1,
        usedPromoCode: 1,
      },
    }
  );
  if (!user) {
    return { ok: false, status: 404, error: 'User not found' };
  }

  const ownCode = (user.promoCode || '').toUpperCase();
  if (typeof promoCode === 'string' && promoCode.trim()) {
    const requestedCode = promoCode.trim().toUpperCase();
    if (!ownCode || requestedCode !== ownCode) {
      return { ok: false, status: 403, error: 'You can only access your own referral stats' };
    }
  }

  let referrals = [];
  if (ownCode) {
    referrals = await users.find({
      $or: [{ referredBy: ownCode }, { usedPromoCode: ownCode }],
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .project({ userId: 1, name: 1, username: 1, paymentStatus: 1, createdAt: 1 })
      .toArray();
  }

  const paidCount = referrals.filter(r => r.paymentStatus === 'paid').length;

  return {
    ok: true,
    data: {
      promoCode: ownCode || null,
      invitedCount: user.invitedCount || 0,
      actualReferredCount: referrals.length,
      paidCount,
      hasRedeemedReferral: Boolean(user.hasRedeemedReferral || user.referredBy || user.usedPromoCode),
      referredBy: user.referredBy || user.usedPromoCode || null,
      referrals,
    },
  };
}

const SUBSCRIPTION_DAYS = 90;
const SUBSCRIPTION_DURATION_MS = SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000;
const DEMO_DURATION_MS = 24 * 60 * 60 * 1000;

async function updatePaymentStatus(userId, status, additionalData = {}, deps = {}) {
  const uid = parseInt(userId, 10);
  if (!Number.isInteger(uid)) return false;
  const db = deps.db || getDB();
  const now = deps.now ? new Date(deps.now) : new Date();
  const users = db.collection('users');
  const result = await users.updateOne(
    { userId: uid },
    { $set: { paymentStatus: status, updatedAt: now, ...additionalData } }
  );
  console.log(`💳 Статус оплаты пользователя ${uid}: ${status}`);
  return result.modifiedCount > 0;
}

async function approvePayment(userId, deps = {}) {
  const uid = parseInt(userId, 10);
  if (!Number.isInteger(uid)) {
    return { approved: false, alreadyProcessed: false, reason: 'invalid_user_id', subscriptionExpiresAt: null };
  }

  const db = deps.db || getDB();
  const now = deps.now ? new Date(deps.now) : new Date();
  const users = db.collection('users');
  const defaultExpiresAt = new Date(now.getTime() + SUBSCRIPTION_DURATION_MS);

  // Атомарно меняем статус только если он сейчас 'pending'.
  // В mongodb@5.9.2 findOneAndUpdate возвращает { value, ok }, поэтому
  // обязательно распаковываем через unwrapModifyResult.
  const rawResult = await users.findOneAndUpdate(
    { userId: uid, paymentStatus: 'pending' },
    {
      $set: {
        paymentStatus: 'paid',
        accessType: 'full',
        paymentDate: now,
        subscriptionExpiresAt: defaultExpiresAt,
        subscriptionNotified3Days: false,
        subscriptionNotified1Day: false,
        onboardingCompleted: true,
        updatedAt: now,
      }
    },
    { returnDocument: 'before' }
  );

  const previousUser = unwrapModifyResult(rawResult);
  if (!previousUser) {
    return { approved: false, alreadyProcessed: true, reason: 'not_pending', subscriptionExpiresAt: null };
  }

  let finalExpiresAt = defaultExpiresAt;
  // Если пользователь продлевает ещё активную подписку — добавляем 90 дней к текущей дате окончания.
  if (previousUser.subscriptionExpiresAt) {
    const prevExpiry = new Date(previousUser.subscriptionExpiresAt);
    if (!Number.isNaN(prevExpiry.getTime()) && prevExpiry > now) {
      finalExpiresAt = new Date(prevExpiry.getTime() + SUBSCRIPTION_DURATION_MS);
      await users.updateOne(
        { userId: uid },
        { $set: { subscriptionExpiresAt: finalExpiresAt, updatedAt: now } }
      );
    }
  }

  // XP за оплату начисляется в bot.js через claimPaymentBonus — не здесь.
  return {
    approved: true,
    alreadyProcessed: false,
    subscriptionExpiresAt: finalExpiresAt,
  };
}

async function rejectPayment(userId, deps = {}) {
  const uid = parseInt(userId, 10);
  if (!Number.isInteger(uid)) {
    return { rejected: false, alreadyProcessed: false, demoStatus: 'none', demoExpiresAt: null };
  }

  const db = deps.db || getDB();
  const now = deps.now ? new Date(deps.now) : new Date();
  const users = db.collection('users');

  // Атомарно меняем статус только если он сейчас 'pending'.
  // returnDocument: 'before' — читаем состояние ДО записи, чтобы правильно
  // решить, давать ли демо. Распаковываем { value, ok } через unwrapModifyResult.
  const rawResult = await users.findOneAndUpdate(
    { userId: uid, paymentStatus: 'pending' },
    { $set: { paymentStatus: 'unpaid', updatedAt: now } },
    { returnDocument: 'before' }
  );

  const previousUser = unwrapModifyResult(rawResult);
  if (!previousUser) {
    // Уже отклонено, уже одобрено или пользователь не найден — НЕ трогаем accessType/demoExpiresAt!
    return { rejected: false, alreadyProcessed: true, demoStatus: 'none', demoExpiresAt: null };
  }

  // Если пользователь пытался продлить ещё активную подписку — сохраняем оставшийся доступ.
  const prevSubExpiry = previousUser.subscriptionExpiresAt ? new Date(previousUser.subscriptionExpiresAt) : null;
  if (prevSubExpiry && !Number.isNaN(prevSubExpiry.getTime()) && prevSubExpiry > now) {
    await users.updateOne(
      { userId: uid },
      { $set: { paymentStatus: 'paid', accessType: 'full', updatedAt: now } }
    );
    return { rejected: true, alreadyProcessed: false, demoStatus: 'none', demoExpiresAt: null };
  }

  const nextPaymentStatus = (prevSubExpiry && !Number.isNaN(prevSubExpiry.getTime()) && prevSubExpiry <= now)
    ? 'subscription_expired'
    : 'unpaid';

  let demoExpiresAt = previousUser.demoExpiresAt ? new Date(previousUser.demoExpiresAt) : null;
  let accessType = null;
  let demoStatus = 'none';

  const hasActiveDemo = previousUser.accessType === 'demo'
    && demoExpiresAt
    && !Number.isNaN(demoExpiresAt.getTime())
    && now < demoExpiresAt;

  if (hasActiveDemo) {
    accessType = 'demo';
    demoStatus = 'active';
  } else if (previousUser.demoGivenOnRejection || previousUser.demoActivatedManually || previousUser.paymentDate) {
    demoStatus = 'none';
    accessType = null;
  } else {
    demoExpiresAt = new Date(now.getTime() + DEMO_DURATION_MS);
    accessType = 'demo';
    demoStatus = 'given_new';
  }

  await users.updateOne({ userId: uid }, {
    $set: {
      paymentStatus: nextPaymentStatus,
      accessType,
      demoExpiresAt,
      demoGivenOnRejection: demoStatus === 'given_new' ? true : Boolean(previousUser.demoGivenOnRejection),
      ...(demoStatus === 'given_new' ? { demoExpiredNotified: false } : {}),
      updatedAt: now
    }
  });

  return { rejected: true, alreadyProcessed: false, demoStatus, demoExpiresAt };
}

/**
 * Атомарно активирует разовый 24-часовой демо-доступ вручную.
 * Защищает от повторного получения демо после истечения (проверяет demoActivatedManually и demoGivenOnRejection).
 */
async function activateManualDemo(userId, deps = {}) {
  const uid = parseInt(userId, 10);
  if (!Number.isInteger(uid)) {
    return { activated: false, reason: 'invalid_user_id', demoExpiresAt: null };
  }

  const db = deps.db || getDB();
  const now = deps.now ? new Date(deps.now) : new Date();
  const users = db.collection('users');
  const demoExpiresAt = new Date(now.getTime() + DEMO_DURATION_MS);

  const rawResult = await users.findOneAndUpdate(
    {
      userId: uid,
      paymentStatus: { $ne: 'paid' },
      demoGivenOnRejection: { $ne: true },
      demoActivatedManually: { $ne: true },
    },
    {
      $set: {
        accessType: 'demo',
        demoExpiresAt,
        onboardingCompleted: true,
        paymentStatus: 'unpaid',
        demoActivatedManually: true,
        demoExpiredNotified: false,
        updatedAt: now,
      }
    },
    { returnDocument: 'after' }
  );

  const updated = unwrapModifyResult(rawResult);
  if (updated) {
    return { activated: true, reason: 'activated', demoExpiresAt };
  }

  const existing = await users.findOne({ userId: uid });
  if (!existing) {
    return { activated: false, reason: 'user_not_found', demoExpiresAt: null };
  }
  if (existing.paymentStatus === 'paid') {
    return { activated: false, reason: 'already_paid', demoExpiresAt: null };
  }
  if (existing.accessType === 'demo' && existing.demoExpiresAt && now < new Date(existing.demoExpiresAt)) {
    return { activated: false, reason: 'already_active', demoExpiresAt: new Date(existing.demoExpiresAt) };
  }
  return { activated: false, reason: 'already_used', demoExpiresAt: existing.demoExpiresAt ? new Date(existing.demoExpiresAt) : null };
}

async function getPendingPayments(deps = {}) {
  const db = deps.db || getDB();
  return await db.collection('users').find({ paymentStatus: 'pending' }).toArray();
}

async function checkDemoExpiration(userId, deps = {}) {
  const uid = parseInt(userId, 10);
  if (!Number.isInteger(uid)) return false;
  const db = deps.db || getDB();
  const now = deps.now ? new Date(deps.now) : new Date();
  const user = await db.collection('users').findOne({ userId: uid });
  if (!user || user.accessType !== 'demo' || !user.demoExpiresAt) return false;
  const expiresAt = new Date(user.demoExpiresAt);
  if (Number.isNaN(expiresAt.getTime())) return false;
  return expiresAt <= now;
}

async function getUserAccess(userId, deps = {}) {
  const uid = parseInt(userId, 10);
  if (!Number.isInteger(uid)) {
    return { hasAccess: false, paymentStatus: 'unpaid', reason: 'invalid_user_id' };
  }

  const mainAdminRaw = process.env.MAIN_ADMIN_ID;
  const mainAdmin = mainAdminRaw ? parseInt(String(mainAdminRaw).trim(), 10) : NaN;
  if (Number.isInteger(mainAdmin) && uid === mainAdmin) {
    return { hasAccess: true, paymentStatus: 'paid', reason: 'admin_access' };
  }

  const db = deps.db || getDB();
  const now = deps.now ? new Date(deps.now) : new Date();
  const user = await db.collection('users').findOne({ userId: uid });
  if (!user) return { hasAccess: false, paymentStatus: 'unpaid', reason: 'user_not_found' };

  // 1. Активная оплаченная подписка (всегда имеет приоритет над старыми demo-полями)
  if (user.paymentStatus === 'paid') {
    if (user.subscriptionExpiresAt) {
      const expiresAt = new Date(user.subscriptionExpiresAt);
      if (!Number.isNaN(expiresAt.getTime())) {
        if (now < expiresAt) {
          return {
            hasAccess: true,
            paymentStatus: 'paid',
            subscriptionExpires: expiresAt.toISOString(),
            daysLeft: Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
          };
        }
        return {
          hasAccess: false,
          paymentStatus: 'subscription_expired',
          reason: 'subscription_expired',
          subscriptionExpires: expiresAt.toISOString(),
          subscriptionExpired: true,
        };
      }
    }
    return { hasAccess: true, paymentStatus: 'paid', reason: 'legacy_user' };
  }

  // 2. Чек на проверке (если есть ещё активная подписка или активный демо — сохраняем доступ,
  //    иначе показываем экран ожидания PendingScreen, даже если ранее был истёкший демо)
  if (user.paymentStatus === 'pending') {
    if (user.subscriptionExpiresAt) {
      const subExpires = new Date(user.subscriptionExpiresAt);
      if (!Number.isNaN(subExpires.getTime()) && now < subExpires) {
        return {
          hasAccess: true,
          paymentStatus: 'paid',
          subscriptionExpires: subExpires.toISOString(),
          daysLeft: Math.ceil((subExpires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
          paymentPending: true,
        };
      }
    }
    if (user.accessType === 'demo' && user.demoExpiresAt) {
      const demoExpires = new Date(user.demoExpiresAt);
      if (!Number.isNaN(demoExpires.getTime()) && now < demoExpires) {
        return {
          hasAccess: true,
          paymentStatus: 'demo',
          demoExpires: demoExpires.toISOString(),
          paymentPending: true,
        };
      }
    }
    return { hasAccess: false, paymentStatus: 'pending', reason: 'payment_pending' };
  }

  // 3. Демо-доступ
  if (user.accessType === 'demo' && user.demoExpiresAt) {
    const expiresAt = new Date(user.demoExpiresAt);
    if (!Number.isNaN(expiresAt.getTime()) && now < expiresAt) {
      return { hasAccess: true, paymentStatus: 'demo', demoExpires: expiresAt.toISOString() };
    }
    if (user.paymentStatus === 'subscription_expired') {
      return {
        hasAccess: false,
        paymentStatus: 'subscription_expired',
        reason: 'subscription_expired',
        subscriptionExpires: user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt).toISOString() : undefined,
        subscriptionExpired: true,
      };
    }
    return { hasAccess: false, paymentStatus: 'unpaid', reason: 'demo_expired' };
  }

  // 4. Истёкшая подписка
  if (user.paymentStatus === 'subscription_expired') {
    return {
      hasAccess: false,
      paymentStatus: 'subscription_expired',
      reason: 'subscription_expired',
      subscriptionExpires: user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt).toISOString() : undefined,
      subscriptionExpired: true,
    };
  }

  return { hasAccess: false, paymentStatus: 'unpaid', reason: 'not_paid' };
}

async function addUserXP(userId, amount, reason = '', deps = {}) {
  return withUserLock(userId, async () => {
    try {
      const db = deps.db || getDB();
      const addContestXpFn = deps.addContestXp || addContestXp;
      const checkBadgesFn = deps.checkAndUnlockBadges || (deps.db ? async () => [] : checkAndUnlockBadges);
      const result = await db.collection('users').updateOne(
        { userId: parseInt(userId) },
        { $inc: { xp: amount }, $set: { updatedAt: new Date() } }
      );
      if (result.modifiedCount > 0) {
        await checkBadgesFn(userId);
        addContestXpFn(userId, amount).catch(err =>
          console.error(`❌ addContestXp error for ${userId}:`, err)
        );
        console.log(`✅ Добавлено ${amount} XP для userId ${userId}. Причина: ${reason}`);
        return true;
      }
      return false;
    } catch (error) { console.error('❌ addUserXP:', error); throw error; }
  });
}

async function getGlobalLeaderboard(limit = 50) {
  try {
    return await getDB().collection('users').find({ paymentStatus: { $in: ['paid', 'demo'] }, xp: { $gt: 0 } })
      .sort({ xp: -1 }).limit(limit)
      .project({ userId: 1, username: 1, name: 1, photoUrl: 1, xp: 1, currentStreak: 1, unlockedBadges: 1, invitedCount: 1 })
      .toArray();
  } catch (error) { console.error('❌ getGlobalLeaderboard:', error); throw error; }
}

async function getUserRank(userId) {
  try {
    const users = getDB().collection('users');
    const user = await users.findOne({ userId: parseInt(userId) });
    if (!user) return { rank: null, totalUsers: 0 };
    const rank = await users.countDocuments({ paymentStatus: { $in: ['paid', 'demo'] }, xp: { $gt: user.xp } }) + 1;
    const totalUsers = await users.countDocuments({ paymentStatus: { $in: ['paid', 'demo'] }, xp: { $gt: 0 } });
    return { rank, totalUsers, userXP: user.xp };
  } catch (error) { console.error('❌ getUserRank:', error); throw error; }
}

async function getFriendsLeaderboard(userId, limit = 20, deps = {}) {
  try {
    const users = (deps.db || getDB()).collection('users');
    const user = await users.findOne({ userId: parseInt(userId, 10) });
    if (!user || !user.promoCode) return [];
    return await users.find({
      $or: [{ referredBy: user.promoCode }, { usedPromoCode: user.promoCode }],
      paymentStatus: { $in: ['paid', 'demo'] }
    })
      .sort({ xp: -1 }).limit(limit)
      .project({ userId: 1, username: 1, name: 1, photoUrl: 1, xp: 1, currentStreak: 1, unlockedBadges: 1 })
      .toArray();
  } catch (error) { console.error('❌ getFriendsLeaderboard:', error); throw error; }
}

async function checkAndUnlockBadges(userId) {
  try {
    const users = getDB().collection('users');
    const user = await users.findOne({ userId });
    if (!user) return;
    const unlockedBadges = user.unlockedBadges || [];
    let newBadges = [...unlockedBadges];
    if ((user.invitedCount || 0) >= 10 && !newBadges.includes('social_butterfly')) newBadges.push('social_butterfly');
    const friendsLeaderboard = await getFriendsLeaderboard(userId, 20);
    if (friendsLeaderboard?.length > 0 && friendsLeaderboard[0].userId === userId && !newBadges.includes('friends_leader')) newBadges.push('friends_leader');
    if (user.xp >= 10000 && !newBadges.includes('legend')) newBadges.push('legend');
    const newlyAdded = newBadges.filter(b => !unlockedBadges.includes(b));
    if (newlyAdded.length > 0) {
      await users.updateOne({ userId }, { $addToSet: { unlockedBadges: { $each: newlyAdded } } });
    }
    return newBadges;
  } catch (error) { console.error('Ошибка checkAndUnlockBadges:', error); return []; }
}

async function getCountries() {
  try {
    const countries = await getDB().collection('users').distinct('location.country', { 'location.country': { $ne: null }, onboardingCompleted: true });
    const norm = { 'Қазақстан': 'Kazakhstan', 'Ресей': 'Russia', 'Россия': 'Russia', 'Түркия': 'Turkey', 'Турция': 'Turkey', 'Өзбекстан': 'Uzbekistan', 'Узбекістан': 'Uzbekistan', 'Узбекистан': 'Uzbekistan' };
    return [...new Set(countries.map(c => norm[c] || c).filter(c => c && c !== 'Unknown'))].sort();
  } catch (error) { return []; }
}

async function getCities(country) {
  try {
    const cities = await getDB().collection('users').distinct('location.city', { 'location.country': country, 'location.city': { $ne: null }, onboardingCompleted: true });
    return cities.filter(c => c && c !== 'Unknown').sort();
  } catch (error) { return []; }
}

async function getFilteredLeaderboard(options = {}) {
  try {
    const { limit = 50, offset = 0, country = null, city = null } = options;
    const filter = { onboardingCompleted: true, xp: { $gt: 0 } };
    if (country) filter['location.country'] = country;
    if (city) filter['location.city'] = city;
    const leaderboard = await getDB().collection('users').find(filter).sort({ xp: -1 }).skip(offset).limit(limit)
      .project({ userId: 1, username: 1, name: 1, photoUrl: 1, xp: 1, currentStreak: 1, unlockedBadges: 1, invitedCount: 1, 'location.city': 1, 'location.country': 1 })
      .toArray();
    const total = await getDB().collection('users').countDocuments(filter);
    return { data: leaderboard, total, hasMore: offset + limit < total };
  } catch (error) { console.error('❌ getFilteredLeaderboard:', error); throw error; }
}

async function addReferralXP(userId, type = 'registration', referredUserId = null, referredUserName = null, deps = {}) {
  const inviterUid = parseInt(userId, 10);
  const referredUid = referredUserId !== null && referredUserId !== undefined ? parseInt(referredUserId, 10) : null;
  if (!Number.isInteger(inviterUid)) {
    return { success: false, reason: 'invalid_user' };
  }
  if (referredUid !== null && inviterUid === referredUid) {
    return { success: false, reason: 'self_referral' };
  }

  return withUserLock(inviterUid, async () => {
    try {
      const now = deps.nowFn ? deps.nowFn() : new Date();
      if (now.getTime() > EID_AL_FITR_MS) return { success: false, reason: 'period_ended' };
      const users = (deps.db || getDB()).collection('users');
      const addContestXpFn = deps.addContestXp || addContestXp;

      // Читаем только timezone — один лёгкий запрос
      const userTz = await users.findOne(
        { userId: inviterUid },
        { projection: { 'location.timezone': 1 } }
      );
      if (!userTz) return { success: false, reason: 'user_not_found' };
      const todayDateStr = getTodayStr(userTz.location?.timezone || 'Asia/Almaty');

      let finalXP = 0, multiplier = 1.0, todayCount = 0;

      if (type === 'payment') {
        finalXP = 400;
        // Атомарно добавляем XP — без read-then-write
        await users.updateOne(
          { userId: inviterUid },
          { $inc: { xp: finalXP }, $set: { updatedAt: now } }
        );
        addContestXpFn(inviterUid, finalXP).catch(err =>
          console.error(`❌ addContestXp referral-payment error for ${inviterUid}:`, err)
        );
      } else {
        // Атомарно инкрементируем счётчик рефералов и invitedCount,
        // получаем новое значение после инкремента (returnDocument: 'after')
        // В mongodb@5.9.2 findOneAndUpdate возвращает { value, ok }, разворачиваем через unwrapModifyResult
        const updatedRes = await users.findOneAndUpdate(
          { userId: inviterUid },
          {
            $inc: {
              [`dailyReferrals.${todayDateStr}`]: 1,
              invitedCount: 1,
            },
            $set: { updatedAt: now },
          },
          { returnDocument: 'after', projection: { dailyReferrals: 1 } }
        );
        const updatedDoc = unwrapModifyResult(updatedRes);
        if (!updatedDoc) return { success: false, reason: 'user_not_found' };

        // Рассчитываем мультипликатор по актуальному (уже записанному) счётчику
        todayCount = updatedDoc.dailyReferrals?.[todayDateStr] || 1;
        if (todayCount >= 50) multiplier = 2.0;
        else if (todayCount >= 20) multiplier = 1.6;
        else if (todayCount >= 5) multiplier = 1.3;
        finalXP = Math.floor(100 * multiplier);

        // Атомарно добавляем XP
        await users.updateOne(
          { userId: inviterUid },
          { $inc: { xp: finalXP } }
        );
        addContestXpFn(inviterUid, finalXP).catch(err =>
          console.error(`❌ addContestXp referral-reg error for ${inviterUid}:`, err)
        );
      }

      return { success: true, xp: finalXP, multiplier: type === 'payment' ? 1.0 : multiplier, todayCount: type === 'registration' ? todayCount : 0, referredUserName, type };
    } catch (error) { console.error('❌ addReferralXP:', error); return { success: false, reason: 'error' }; }
  });
}

/**
 * Атомарно выставляет флаг referralBonusGiven.
 * Возвращает true только если флаг только что выставлен нами — XP можно начислять.
 * Повторный вызов вернёт false — гарантия от race condition и двойного начисления.
 */
async function claimReferralBonus(userId, deps = {}) {
  const uid = parseInt(userId, 10);
  if (!Number.isInteger(uid)) return false;
  const result = await (deps.db || getDB()).collection('users').findOneAndUpdate(
    { userId: uid, referralBonusGiven: { $ne: true } },
    { $set: { referralBonusGiven: true, updatedAt: new Date() } }
  );
  return unwrapModifyResult(result) !== null;
}

/**
 * Атомарно выставляет флаг paymentBonusGiven.
 * Возвращает true только если флаг только что выставлен нами — XP можно начислять.
 */
async function claimPaymentBonus(userId, deps = {}) {
  const uid = parseInt(userId, 10);
  if (!Number.isInteger(uid)) return false;
  const result = await (deps.db || getDB()).collection('users').findOneAndUpdate(
    { userId: uid, paymentBonusGiven: { $ne: true } },
    { $set: { paymentBonusGiven: true, updatedAt: new Date() } }
  );
  return unwrapModifyResult(result) !== null;
}

export {
  XP_VALUES, GOAL_CATEGORY_MAX_XP, LEGACY_GOAL_CATEGORY_MAP, TASBEEH_XP,
  SUBSCRIPTION_DAYS, DEMO_DURATION_MS,
  normalizeGoalCategoryId, isMondayOrThursday, unwrapModifyResult,
  getOrCreateUser, getUserById, getUserByPromoCode, incrementReferralCount,
  updateUserProgress, getUserFullData, updateUserOnboarding, checkPromoCode,
  redeemReferralCode, getReferralStats,
  updatePaymentStatus, approvePayment, rejectPayment, activateManualDemo, getUserAccess,
  getPendingPayments, checkDemoExpiration, addUserXP, getGlobalLeaderboard,
  getUserRank, getFriendsLeaderboard, getCountries, getCities,
  getFilteredLeaderboard, addReferralXP, claimReferralBonus, claimPaymentBonus
};
