// tests/userLock.race.test.js
// Тесты для withUserLock: проверяем защиту от race condition (double XP).
//
// Запуск: node --test tests/userLock.race.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withUserLock } from '../utils/userLock.js';

// ─── Вспомогательная симуляция read-check-write (как в updateUserProgress) ───
//
// fakeDb — простой объект, имитирующий поле xp одного пользователя в MongoDB.
// readDelay — задержка между чтением и записью (создаёт окно для race condition).

async function simulateXpSync(fakeDb, xpToAdd, readDelay = 10) {
  // 1. Чтение (snapshot, как findOne)
  const snapshot = { xp: fakeDb.xp };

  // 2. Симулируем задержку (сетевая латентность, вычисления)
  await new Promise(r => setTimeout(r, readDelay));

  // 3. Запись на основе прочитанного snapshot (как updateOne с $set)
  fakeDb.xp = snapshot.xp + xpToAdd;
}

// ─── Тест 1: без лока — race condition воспроизводится ─────────────────────
describe('без withUserLock', () => {
  test('два конкурентных вызова дают double XP (race condition воспроизводится)', async () => {
    const db = { xp: 0 };
    const XP = 100;

    // Оба запроса стартуют одновременно, без лока
    await Promise.all([
      simulateXpSync(db, XP, 10),
      simulateXpSync(db, XP, 10),
    ]);

    // Ожидаем 200, но из-за race оба прочитали xp=0 → оба записали 100
    // Результат: 100 вместо 200 (второй перезаписал первого)
    // ИЛИ оба успели записать 100 по snapshot 0 → итог 100, а не 200.
    // В любом случае — результат НЕ равен 200 (правильному значению).
    assert.notEqual(db.xp, XP * 2,
      'ОЖИДАЕМО: race condition ведёт к неправильному результату без лока'
    );
  });
});

// ─── Тест 2: с локом — XP начисляется ровно один раз ──────────────────────
describe('с withUserLock', () => {
  test('два конкурентных вызова для одного userId начисляют XP ровно один раз', async () => {
    const db = { xp: 0 };
    const userId = 42;
    const XP = 100;

    // Используем лок: второй вызов ждёт завершения первого
    await Promise.all([
      withUserLock(userId, () => simulateXpSync(db, XP, 10)),
      withUserLock(userId, () => simulateXpSync(db, XP, 10)),
    ]);

    // Второй вызов прочитал уже обновлённое xp=100 → итог 200
    assert.equal(db.xp, XP * 2, `Ожидается ${XP * 2} XP, получено ${db.xp}`);
  });

  test('три конкурентных вызова выполняются строго по очереди', async () => {
    const log = [];
    const userId = 99;

    const makeTask = (id, delay) => withUserLock(userId, async () => {
      log.push(`start:${id}`);
      await new Promise(r => setTimeout(r, delay));
      log.push(`end:${id}`);
    });

    await Promise.all([makeTask(1, 20), makeTask(2, 10), makeTask(3, 5)]);

    // Порядок старта должен совпадать с порядком завершения (строгая сериализация)
    assert.deepEqual(log, [
      'start:1', 'end:1',
      'start:2', 'end:2',
      'start:3', 'end:3',
    ]);
  });

  test('вызовы для разных userId выполняются параллельно, а не последовательно', async () => {
    const timestamps = {};
    const DELAY = 30;

    const makeTask = (userId) => withUserLock(userId, async () => {
      timestamps[userId] = { start: Date.now() };
      await new Promise(r => setTimeout(r, DELAY));
      timestamps[userId].end = Date.now();
    });

    // Запускаем для трёх разных userId одновременно
    await Promise.all([makeTask(1), makeTask(2), makeTask(3)]);

    // Если они выполнились параллельно — start у всех приблизительно одинаковый
    // и общее время ≈ DELAY, а не 3 * DELAY
    const starts = Object.values(timestamps).map(t => t.start);
    const maxStartDiff = Math.max(...starts) - Math.min(...starts);

    assert.ok(
      maxStartDiff < DELAY,
      `Разные userId должны стартовать параллельно (разброс старта: ${maxStartDiff}ms)`
    );
  });

  test('ошибка в одном вызове не блокирует следующий', async () => {
    const userId = 7;
    const results = [];

    await Promise.allSettled([
      withUserLock(userId, async () => {
        await new Promise(r => setTimeout(r, 5));
        throw new Error('simulated DB error');
      }).catch(() => results.push('error')),

      withUserLock(userId, async () => {
        await new Promise(r => setTimeout(r, 5));
        results.push('success');
      }),
    ]);

    assert.deepEqual(results, ['error', 'success'],
      'После ошибки следующий вызов должен выполниться нормально'
    );
  });
});
