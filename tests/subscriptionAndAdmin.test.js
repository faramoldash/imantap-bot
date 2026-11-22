// tests/subscriptionAndAdmin.test.js
// Unit-тесты Модуля 7: Kaspi-подписка, демо, защита от двойного approve/reject
// (включая формат ModifyResult mongodb@5.9.2 { value, ok }), защита /sync от подмены
// платных/админ-полей, уведомления за 3/1 день и разграничение прав админов/менеджеров.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';

process.env.MONGO_URL ??= 'mongodb://127.0.0.1:27017/imantap_test';

const {
  SUBSCRIPTION_DAYS,
  DEMO_DURATION_MS,
  approvePayment,
  rejectPayment,
  activateManualDemo,
  getUserAccess,
  checkDemoExpiration,
  updateUserProgress,
  claimPaymentBonus,
} = await import('../userService.js');

const {
  isMainAdmin,
  isAdmin,
  addManager,
  removeManager,
  getAdmins,
  listManagers,
} = await import('../adminService.js');

const {
  checkSubscriptionsAndDemos,
  checkExpiredDemos,
} = await import('../schedulerService.js');

const {
  createApiServer,
  sanitizeSyncPayload,
} = await import('../apiServer.js');

const BOT_TOKEN = '123456:module7-test-token';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function createSignedInitData(userId) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAEAAAE',
    user: JSON.stringify({ id: userId, first_name: 'Mod7' }),
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return params.toString();
}

function invokeServer(server, { method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    let statusCode = 200;
    let rawBody = '';
    const res = {
      get statusCode() { return statusCode; },
      set statusCode(c) { statusCode = c; },
      setHeader() {},
      getHeader() { return null; },
      writeHead(c) { statusCode = c; },
      end(chunk = '') {
        if (chunk) rawBody += String(chunk);
        resolve({ status: statusCode, text: rawBody, json: () => JSON.parse(rawBody) });
      },
    };
    try {
      server.emit('request', req, res);
      if (body) req.emit('data', Buffer.from(body));
      req.emit('end');
    } catch (err) {
      reject(err);
    }
  });
}

function cloneDoc(val) {
  if (val instanceof Date) return new Date(val.getTime());
  if (Array.isArray(val)) return val.map(cloneDoc);
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = cloneDoc(v);
    return out;
  }
  return val;
}

function getPath(doc, path) {
  return path.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), doc);
}

function setPath(doc, path, value) {
  const parts = path.split('.');
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = cloneDoc(value);
}

function toComparable(val) {
  return val instanceof Date ? val.getTime() : val;
}

function matchesCondition(actual, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    for (const [op, expected] of Object.entries(cond)) {
      if (op === '$ne') {
        if (toComparable(actual) === toComparable(expected)) return false;
      } else if (op === '$nin') {
        if (expected.includes(actual)) return false;
      } else if (op === '$in') {
        if (!expected.includes(actual)) return false;
      } else if (op === '$gt') {
        if (actual == null || !(toComparable(actual) > toComparable(expected))) return false;
      } else if (op === '$gte') {
        if (actual == null || !(toComparable(actual) >= toComparable(expected))) return false;
      } else if (op === '$lt') {
        if (actual == null || !(toComparable(actual) < toComparable(expected))) return false;
      } else if (op === '$lte') {
        if (actual == null || !(toComparable(actual) <= toComparable(expected))) return false;
      } else if (op === '$exists') {
        if ((actual !== undefined) !== Boolean(expected)) return false;
      } else {
        throw new Error(`Unsupported operator in test mock: ${op}`);
      }
    }
    return true;
  }
  return toComparable(actual) === toComparable(cond);
}

function matchesFilter(doc, filter = {}) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or') {
      if (!cond.some(sub => matchesFilter(doc, sub))) return false;
      continue;
    }
    const actual = getPath(doc, key);
    if (!matchesCondition(actual, cond)) return false;
  }
  return true;
}

/**
 * In-memory MongoDB mock, эмулирующий поведение mongodb@5.9.2:
 * findOneAndUpdate ВСЕГДА возвращает ModifyResult { value: doc | null, ok: 1 }!
 */
function createMockDb(initial = {}) {
  const store = {
    users: (initial.users || []).map(cloneDoc),
    admins: (initial.admins || []).map(cloneDoc),
  };

  function makeCollection(name) {
    if (!store[name]) store[name] = [];
    const list = store[name];
    return {
      async findOne(filter) {
        const found = list.find(d => matchesFilter(d, filter));
        return found ? cloneDoc(found) : null;
      },
      find(filter = {}) {
        const matched = list.filter(d => matchesFilter(d, filter)).map(cloneDoc);
        return {
          async toArray() { return matched; },
        };
      },
      async insertOne(doc) {
        list.push(cloneDoc(doc));
        return { acknowledged: true };
      },
      async updateOne(filter, update) {
        const doc = list.find(d => matchesFilter(d, filter));
        if (!doc) return { matchedCount: 0, modifiedCount: 0 };
        if (update.$set) {
          for (const [k, v] of Object.entries(update.$set)) setPath(doc, k, v);
        }
        if (update.$inc) {
          for (const [k, v] of Object.entries(update.$inc)) {
            setPath(doc, k, (getPath(doc, k) || 0) + v);
          }
        }
        return { matchedCount: 1, modifiedCount: 1 };
      },
      async deleteOne(filter) {
        const idx = list.findIndex(d => matchesFilter(d, filter));
        if (idx === -1) return { deletedCount: 0 };
        list.splice(idx, 1);
        return { deletedCount: 1 };
      },
      async findOneAndUpdate(filter, update, options = {}) {
        const doc = list.find(d => matchesFilter(d, filter));
        if (!doc) {
          // Точное поведение mongodb@5.9.2: truthy объект с value: null!
          return { value: null, ok: 1, lastErrorObject: { n: 0, updatedExisting: false } };
        }
        const before = cloneDoc(doc);
        if (update.$set) {
          for (const [k, v] of Object.entries(update.$set)) setPath(doc, k, v);
        }
        if (update.$inc) {
          for (const [k, v] of Object.entries(update.$inc)) {
            setPath(doc, k, (getPath(doc, k) || 0) + v);
          }
        }
        const after = cloneDoc(doc);
        return {
          value: options.returnDocument === 'after' ? after : before,
          ok: 1,
          lastErrorObject: { n: 1, updatedExisting: true },
        };
      },
    };
  }

  return {
    store,
    collection: makeCollection,
  };
}

// ============================================================================
// 1. Переходы статусов доступа, расчёт demoExpiresAt и subscriptionExpiresAt
// ============================================================================

test('access lifecycle: unpaid → pending → paid (+90 days) → subscription_expired', async () => {
  const prevMainAdmin = process.env.MAIN_ADMIN_ID;
  process.env.MAIN_ADMIN_ID = '999999';
  try {
    const t0 = new Date('2026-05-01T10:00:00.000Z');
    const db = createMockDb({
      users: [{ userId: 101, paymentStatus: 'unpaid', accessType: null }],
    });

    // 1. unpaid
    const a1 = await getUserAccess(101, { db, now: t0 });
    assert.equal(a1.hasAccess, false);
    assert.equal(a1.paymentStatus, 'unpaid');

    // 2. pending (после отправки чека)
    await db.collection('users').updateOne({ userId: 101 }, { $set: { paymentStatus: 'pending' } });
    const a2 = await getUserAccess(101, { db, now: t0 });
    assert.equal(a2.hasAccess, false);
    assert.equal(a2.paymentStatus, 'pending');

    // 3. paid (одобрение чека → ровно +90 дней)
    const approval = await approvePayment(101, { db, now: t0 });
    assert.equal(approval.approved, true);
    assert.equal(approval.alreadyProcessed, false);
    const expectedExpiry = new Date(t0.getTime() + SUBSCRIPTION_DAYS * DAY_MS);
    assert.equal(approval.subscriptionExpiresAt.getTime(), expectedExpiry.getTime());

    const a3 = await getUserAccess(101, { db, now: new Date(t0.getTime() + 10 * DAY_MS) });
    assert.equal(a3.hasAccess, true);
    assert.equal(a3.paymentStatus, 'paid');
    assert.equal(a3.daysLeft, 80);

    // 4. subscription_expired после 90 дней
    const after90 = new Date(expectedExpiry.getTime() + 1000);
    const a4 = await getUserAccess(101, { db, now: after90 });
    assert.equal(a4.hasAccess, false);
    assert.equal(a4.paymentStatus, 'subscription_expired');
    assert.equal(a4.subscriptionExpired, true);
  } finally {
    process.env.MAIN_ADMIN_ID = prevMainAdmin;
  }
});

test('early renewal preserves remaining days and extends subscriptionExpiresAt by +90 days', async () => {
  const t0 = new Date('2026-05-01T10:00:00.000Z');
  const existingExpiry = new Date(t0.getTime() + 3 * DAY_MS);
  const db = createMockDb({
    users: [{
      userId: 102,
      paymentStatus: 'pending',
      accessType: 'full',
      subscriptionExpiresAt: existingExpiry,
    }],
  });

  // Пока чек раннего продления на проверке — оставшиеся 3 дня доступа сохраняются!
  const duringPending = await getUserAccess(102, { db, now: t0 });
  assert.equal(duringPending.hasAccess, true);
  assert.equal(duringPending.paymentStatus, 'paid');
  assert.equal(duringPending.paymentPending, true);

  // Одобрение добавляет 90 дней к existingExpiry (итого 93 дня от t0)
  const approval = await approvePayment(102, { db, now: t0 });
  assert.equal(approval.approved, true);
  assert.equal(
    approval.subscriptionExpiresAt.getTime(),
    existingExpiry.getTime() + SUBSCRIPTION_DAYS * DAY_MS
  );
});

test('demo lifecycle: activateManualDemo (+24h), blocks repeat activation, expired demo + pending receipt shows pending', async () => {
  const prevMainAdmin = process.env.MAIN_ADMIN_ID;
  process.env.MAIN_ADMIN_ID = '999999';
  try {
    const t0 = new Date('2026-05-01T10:00:00.000Z');
    const db = createMockDb({
      users: [{ userId: 103, paymentStatus: 'unpaid', accessType: null }],
    });

    // Первая активация ручного демо — ровно +24 часа
    const d1 = await activateManualDemo(103, { db, now: t0 });
    assert.equal(d1.activated, true);
    assert.equal(d1.demoExpiresAt.getTime(), t0.getTime() + DEMO_DURATION_MS);

    // Пока активно
    const accessActive = await getUserAccess(103, { db, now: new Date(t0.getTime() + 12 * HOUR_MS) });
    assert.equal(accessActive.hasAccess, true);
    assert.equal(accessActive.paymentStatus, 'demo');
    assert.equal(await checkDemoExpiration(103, { db, now: new Date(t0.getTime() + 12 * HOUR_MS) }), false);

    // Повторная активация пока активно — запрещена
    const d2 = await activateManualDemo(103, { db, now: new Date(t0.getTime() + 12 * HOUR_MS) });
    assert.equal(d2.activated, false);
    assert.equal(d2.reason, 'already_active');

    // После 24ч — демо истёк
    const tExpired = new Date(t0.getTime() + 25 * HOUR_MS);
    assert.equal(await checkDemoExpiration(103, { db, now: tExpired }), true);
    const accessExpired = await getUserAccess(103, { db, now: tExpired });
    assert.equal(accessExpired.hasAccess, false);
    assert.equal(accessExpired.paymentStatus, 'unpaid');
    assert.equal(accessExpired.reason, 'demo_expired');

    // Защита от бесконечного демо: после истечения повторная активация НЕВОЗМОЖНА
    const d3 = await activateManualDemo(103, { db, now: tExpired });
    assert.equal(d3.activated, false);
    assert.equal(d3.reason, 'already_used');

    // Пользователь с истёкшим демо отправляет чек → должен видеть PendingScreen (paymentStatus: 'pending'), НЕ demo_expired!
    await db.collection('users').updateOne({ userId: 103 }, { $set: { paymentStatus: 'pending' } });
    const accessPending = await getUserAccess(103, { db, now: tExpired });
    assert.equal(accessPending.hasAccess, false);
    assert.equal(accessPending.paymentStatus, 'pending');
    assert.equal(accessPending.reason, 'payment_pending');
  } finally {
    process.env.MAIN_ADMIN_ID = prevMainAdmin;
  }
});

// ============================================================================
// 2. Защита от двойного approve / reject (включая mongodb@5.9.2 { value, ok })
// ============================================================================

test('concurrent double approvePayment: atomic via unwrapModifyResult, no double extension or bonus', async () => {
  const t0 = new Date('2026-05-01T10:00:00.000Z');
  const db = createMockDb({
    users: [{ userId: 201, paymentStatus: 'pending', referredBy: 'REF123' }],
  });

  const [r1, r2] = await Promise.all([
    approvePayment(201, { db, now: t0 }),
    approvePayment(201, { db, now: t0 }),
  ]);

  const approvedCount = [r1, r2].filter(r => r.approved).length;
  const alreadyProcessedCount = [r1, r2].filter(r => r.alreadyProcessed).length;
  assert.equal(approvedCount, 1, 'Только один из двух параллельных approve должен сработать');
  assert.equal(alreadyProcessedCount, 1);

  const user = await db.collection('users').findOne({ userId: 201 });
  assert.equal(user.paymentStatus, 'paid');
  assert.equal(user.accessType, 'full');
  assert.equal(user.subscriptionExpiresAt.getTime(), t0.getTime() + SUBSCRIPTION_DAYS * DAY_MS);

  // Реферальный бонус за оплату тоже атомарно срабатывает ровно 1 раз
  const [b1, b2] = await Promise.all([
    claimPaymentBonus(201, { db }),
    claimPaymentBonus(201, { db }),
  ]);
  assert.deepEqual([b1, b2].sort(), [false, true]);
});

test('concurrent approve vs reject: reject after approve NEVER overwrites paid status or accessType', async () => {
  const t0 = new Date('2026-05-01T10:00:00.000Z');
  const db = createMockDb({
    users: [{ userId: 202, paymentStatus: 'pending', accessType: null }],
  });

  const approveRes = await approvePayment(202, { db, now: t0 });
  assert.equal(approveRes.approved, true);

  // Второй админ нажимает «Отклонить» по старому сообщению в чате
  const rejectRes = await rejectPayment(202, { db, now: t0 });
  assert.equal(rejectRes.rejected, false);
  assert.equal(rejectRes.alreadyProcessed, true);
  assert.equal(rejectRes.demoStatus, 'none');

  // Подписка и accessType='full' остались нетронутыми!
  const user = await db.collection('users').findOne({ userId: 202 });
  assert.equal(user.paymentStatus, 'paid');
  assert.equal(user.accessType, 'full');
  assert.equal(user.demoGivenOnRejection, undefined);
});

test('double rejectPayment & repeat rejection after demo used: gives 24h demo only once', async () => {
  const t0 = new Date('2026-05-01T10:00:00.000Z');
  const db = createMockDb({
    users: [{ userId: 203, paymentStatus: 'pending', accessType: null }],
  });

  // Параллельное двойное отклонение одного чека
  const [r1, r2] = await Promise.all([
    rejectPayment(203, { db, now: t0 }),
    rejectPayment(203, { db, now: t0 }),
  ]);

  const winner = r1.rejected ? r1 : r2;
  const loser = r1.rejected ? r2 : r1;
  assert.equal(winner.rejected, true);
  assert.equal(winner.demoStatus, 'given_new');
  assert.equal(winner.demoExpiresAt.getTime(), t0.getTime() + DEMO_DURATION_MS);
  assert.equal(loser.rejected, false);
  assert.equal(loser.alreadyProcessed, true);

  // Через 25 часов (демо истёк) юзер снова шлёт фейковый чек → отклонение НЕ выдаёт новый демо!
  const tLater = new Date(t0.getTime() + 25 * HOUR_MS);
  await db.collection('users').updateOne({ userId: 203 }, { $set: { paymentStatus: 'pending' } });
  const r3 = await rejectPayment(203, { db, now: tLater });
  assert.equal(r3.rejected, true);
  assert.equal(r3.demoStatus, 'none');

  const user = await db.collection('users').findOne({ userId: 203 });
  assert.equal(user.accessType, null);
  assert.equal(user.paymentStatus, 'unpaid');
  assert.equal(user.demoGivenOnRejection, true);
});

// ============================================================================
// 3. Уведомления за 3 и 1 день + истечение подписки и демо (schedulerService)
// ============================================================================

test('checkSubscriptionsAndDemos covers 3-day, 1-day (including morning UTC), expired sub, expired demo', async () => {
  const now = new Date('2026-05-10T10:00:00.000Z');
  const sent = [];
  const bot = {
    async sendMessage(chatId, text, opts) {
      sent.push({ chatId, text, opts });
    },
  };

  const db = createMockDb({
    users: [
      // Истекает через 2 дня 20 часов (06:00 UTC — раньше попадал в «слепую зону»!)
      {
        userId: 301,
        paymentStatus: 'paid',
        accessType: 'full',
        language: 'ru',
        location: { timezone: 'Asia/Almaty' },
        subscriptionExpiresAt: new Date(now.getTime() + 68 * HOUR_MS),
        subscriptionNotified3Days: false,
        subscriptionNotified1Day: false,
      },
      // Истекает через 18 часов (04:00 UTC — раньше тоже попадал в «слепую зону»!)
      {
        userId: 302,
        paymentStatus: 'paid',
        accessType: 'full',
        language: 'kk',
        location: { timezone: 'Asia/Almaty' },
        subscriptionExpiresAt: new Date(now.getTime() + 18 * HOUR_MS),
        subscriptionNotified3Days: true,
        subscriptionNotified1Day: false,
      },
      // Подписка уже истекла 2 часа назад
      {
        userId: 303,
        paymentStatus: 'paid',
        accessType: 'full',
        language: 'ru',
        location: { timezone: 'Asia/Almaty' },
        subscriptionExpiresAt: new Date(now.getTime() - 2 * HOUR_MS),
      },
      // Демо уже истёк 1 час назад
      {
        userId: 304,
        paymentStatus: 'unpaid',
        accessType: 'demo',
        language: 'kk',
        demoExpiresAt: new Date(now.getTime() - 1 * HOUR_MS),
      },
      // Активная подписка (ещё 30 дней) — не должна получить уведомление
      {
        userId: 305,
        paymentStatus: 'paid',
        accessType: 'full',
        subscriptionExpiresAt: new Date(now.getTime() + 30 * DAY_MS),
      },
    ],
  });

  const stats = await checkSubscriptionsAndDemos({ bot, db, now, delayMs: 0 });
  assert.deepEqual(stats, {
    notified3Days: 1,
    notified1Day: 1,
    expiredSubscriptions: 1,
    expiredDemos: 1,
  });

  // Проверяем локализацию и получателей
  const msg301 = sent.find(m => m.chatId === 301);
  assert.ok(msg301 && msg301.text.includes('Подписка скоро заканчивается'));
  const msg302 = sent.find(m => m.chatId === 302);
  assert.ok(msg302 && msg302.text.includes('Жазылым ертең аяқталады'));
  const msg303 = sent.find(m => m.chatId === 303);
  assert.ok(msg303 && msg303.text.includes('Срок подписки истёк'));
  const msg304 = sent.find(m => m.chatId === 304);
  assert.ok(msg304 && msg304.text.includes('Демо-режим аяқталды'));
  assert.equal(sent.find(m => m.chatId === 305), undefined);

  // Проверяем состояния в БД
  const u301 = await db.collection('users').findOne({ userId: 301 });
  const u302 = await db.collection('users').findOne({ userId: 302 });
  const u303 = await db.collection('users').findOne({ userId: 303 });
  const u304 = await db.collection('users').findOne({ userId: 304 });
  assert.equal(u301.subscriptionNotified3Days, true);
  assert.equal(u302.subscriptionNotified1Day, true);
  assert.equal(u303.paymentStatus, 'subscription_expired');
  assert.equal(u303.accessType, null);
  assert.equal(u304.accessType, null);
  assert.equal(u304.demoExpiredNotified, true);

  // Повторный запуск в тот же момент — полная идемпотентность (0 дублей)
  const repeat = await checkSubscriptionsAndDemos({ bot, db, now, delayMs: 0 });
  assert.deepEqual(repeat, {
    notified3Days: 0,
    notified1Day: 0,
    expiredSubscriptions: 0,
    expiredDemos: 0,
  });
});

// ============================================================================
// 4. Защита POST /api/user/:id/sync от подмены платных и админских полей
// ============================================================================

test('POST /api/user/:id/sync strips and ignores paymentStatus, accessType, paidAmount, demoExpiresAt, subscriptionExpiresAt', async () => {
  const prevMainAdmin = process.env.MAIN_ADMIN_ID;
  process.env.MAIN_ADMIN_ID = '999999';
  try {
    const now = new Date('2026-05-10T10:00:00.000Z');
    const db = createMockDb({
      users: [{
        userId: 401,
        paymentStatus: 'unpaid',
        accessType: null,
        paidAmount: null,
        demoExpiresAt: null,
        subscriptionExpiresAt: null,
        hasDiscount: false,
        xp: 100,
        syncVersion: 0,
        location: { timezone: 'Asia/Almaty' },
      }],
    });

    // 1. Проверка sanitizeSyncPayload
    const spoofedPayload = {
      syncVersion: 0,
      language: 'ru',
      paymentStatus: 'paid',
      accessType: 'full',
      paidAmount: 999999,
      demoExpiresAt: '2099-01-01T00:00:00.000Z',
      subscriptionExpiresAt: '2099-01-01T00:00:00.000Z',
      hasDiscount: true,
      demoGivenOnRejection: false,
      demoActivatedManually: false,
      paymentBonusGiven: false,
      xp: 999999,
      role: 'admin',
      isAdmin: true,
    };
    const sanitized = sanitizeSyncPayload(spoofedPayload);
    assert.equal(sanitized.language, 'ru');
    assert.equal(sanitized.paymentStatus, undefined);
    assert.equal(sanitized.accessType, undefined);
    assert.equal(sanitized.paidAmount, undefined);
    assert.equal(sanitized.demoExpiresAt, undefined);
    assert.equal(sanitized.subscriptionExpiresAt, undefined);
    assert.equal(sanitized.xp, undefined);
    assert.equal(sanitized.isAdmin, undefined);

    // 2. End-to-end через HTTP сервер createApiServer
    const server = createApiServer({
      bot: { sendMessage: async () => {} },
      botToken: BOT_TOKEN,
      checkRateLimit: () => true,
      getDb: () => db,
      nowFn: () => now,
      kaspiLink: 'https://pay.kaspi.kz/pay/testlink',
      botUsername: 'imantap_test_bot',
      updateUserProgressFn: (uid, data, deps) => updateUserProgress(uid, data, { ...deps, addContestXp: async () => {} }),
    });

    const initData = createSignedInitData(401);
    const syncRes = await invokeServer(server, {
      method: 'POST',
      url: '/api/user/401/sync',
      headers: {
        'X-Telegram-Init-Data': initData,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(spoofedPayload),
    });

    assert.equal(syncRes.status, 200);
    const userAfter = await db.collection('users').findOne({ userId: 401 });
    assert.equal(userAfter.language, 'ru');
    assert.equal(userAfter.paymentStatus, 'unpaid');
    assert.equal(userAfter.accessType, null);
    assert.equal(userAfter.paidAmount, null);
    assert.equal(userAfter.demoExpiresAt, null);
    assert.equal(userAfter.subscriptionExpiresAt, null);
    assert.equal(userAfter.hasDiscount, false);
    assert.equal(userAfter.xp, 100);
    assert.equal(userAfter.role, undefined);
    assert.equal(userAfter.isAdmin, undefined);

    // 3. Проверка /api/check-access и /api/user/:id/access
    const accessRes = await invokeServer(server, {
      method: 'GET',
      url: '/api/check-access?userId=401',
      headers: { 'X-Telegram-Init-Data': initData },
    });
    assert.equal(accessRes.status, 200);
    const accessBody = accessRes.json();
    assert.equal(accessBody.hasAccess, false);
    assert.equal(accessBody.paymentStatus, 'unpaid');
    assert.equal(accessBody.kaspiLink, 'https://pay.kaspi.kz/pay/testlink');
    assert.equal(accessBody.botUsername, 'imantap_test_bot');
  } finally {
    process.env.MAIN_ADMIN_ID = prevMainAdmin;
  }
});

// ============================================================================
// 5. Права доступа в админке: MAIN_ADMIN_ID vs обычные менеджеры
// ============================================================================

test('adminService enforces MAIN_ADMIN_ID vs manager permissions strictly', async () => {
  const prevMainAdmin = process.env.MAIN_ADMIN_ID;
  process.env.MAIN_ADMIN_ID = '777000';
  try {
    const db = createMockDb();

    assert.equal(isMainAdmin(777000), true);
    assert.equal(isMainAdmin('777000'), true);
    assert.equal(isMainAdmin(888001), false);
    assert.equal(await isAdmin(777000, { db }), true);
    assert.equal(await isAdmin(888001, { db }), false);

    // Обычный пользователь НЕ может добавить менеджера
    const unauthAdd = await addManager(888002, 888001, null, { db });
    assert.equal(unauthAdd.success, false);

    // Главный админ добавляет менеджера 888001
    const addOk = await addManager(888001, 777000, 'manager_one', { db });
    assert.equal(addOk.success, true);

    // Менеджер проходит isAdmin (может одобрять чеки и /pending), но НЕ проходит isMainAdmin!
    assert.equal(await isAdmin(888001, { db }), true);
    assert.equal(isMainAdmin(888001), false);

    // Менеджер НЕ может добавлять других менеджеров
    const mgrAdd = await addManager(888002, 888001, null, { db });
    assert.equal(mgrAdd.success, false);

    // Менеджер НЕ может удалять менеджеров
    const mgrRemove = await removeManager(888001, 888001, { db });
    assert.equal(mgrRemove.success, false);

    // Нельзя добавить дубликат или главного админа в коллекцию менеджеров
    assert.equal((await addManager(888001, 777000, null, { db })).success, false);
    assert.equal((await addManager(777000, 777000, null, { db })).success, false);

    // Нельзя удалить главного админа
    assert.equal((await removeManager(777000, 777000, { db })).success, false);

    // getAdmins включает главного админа и менеджера без дубликатов
    const admins = await getAdmins({ db });
    assert.deepEqual(admins, [777000, 888001]);
    assert.equal((await listManagers({ db })).length, 1);

    // Главный админ удаляет менеджера → теряет доступ isAdmin
    const rmOk = await removeManager(888001, 777000, { db });
    assert.equal(rmOk.success, true);
    assert.equal(await isAdmin(888001, { db }), false);
    assert.deepEqual(await getAdmins({ db }), [777000]);
  } finally {
    process.env.MAIN_ADMIN_ID = prevMainAdmin;
  }
});

test('main admin and manager always get full access without subscription (even in empty DB)', async () => {
  const prevMainAdmin = process.env.MAIN_ADMIN_ID;
  process.env.MAIN_ADMIN_ID = '777000';
  try {
    // Чистая БД: в users нет ни главного админа, ни менеджера; менеджер только в admins
    const db = createMockDb({
      users: [
        { userId: 888002, paymentStatus: 'unpaid', accessType: null },
      ],
      admins: [
        { telegramId: 888001, role: 'manager', addedBy: 777000 },
        { telegramId: 888002, role: 'manager', addedBy: 777000 },
      ],
    });

    // 1. Главный админ — отсутствует в коллекции users (чистая БД)
    const mainAccess = await getUserAccess(777000, { db });
    assert.deepEqual(mainAccess, {
      hasAccess: true,
      accessType: 'full',
      paymentStatus: 'paid',
      reason: 'admin',
    });

    // 2. Менеджер — отсутствует в коллекции users (чистая БД)
    const mgrCleanAccess = await getUserAccess(888001, { db });
    assert.deepEqual(mgrCleanAccess, {
      hasAccess: true,
      accessType: 'full',
      paymentStatus: 'paid',
      reason: 'admin',
    });

    // 3. Менеджер — есть в users со статусом unpaid
    const mgrUnpaidAccess = await getUserAccess(888002, { db });
    assert.deepEqual(mgrUnpaidAccess, {
      hasAccess: true,
      accessType: 'full',
      paymentStatus: 'paid',
      reason: 'admin',
    });

    // 4. End-to-end через HTTP API: /api/check-access, /api/user/:id/access и /api/user/:id/full
    const server = createApiServer({
      bot: { sendMessage: async () => {} },
      botToken: BOT_TOKEN,
      checkRateLimit: () => true,
      getDb: () => db,
    });

    for (const adminId of [777000, 888001, 888002]) {
      const initData = createSignedInitData(adminId);

      const checkRes = await invokeServer(server, {
        method: 'GET',
        url: `/api/check-access?userId=${adminId}`,
        headers: { 'X-Telegram-Init-Data': initData },
      });
      assert.equal(checkRes.status, 200);
      const checkBody = checkRes.json();
      assert.equal(checkBody.hasAccess, true);
      assert.equal(checkBody.accessType, 'full');
      assert.equal(checkBody.paymentStatus, 'paid');
      assert.equal(checkBody.reason, 'admin');

      const accessRes = await invokeServer(server, {
        method: 'GET',
        url: `/api/user/${adminId}/access`,
        headers: { 'X-Telegram-Init-Data': initData },
      });
      assert.equal(accessRes.status, 200);
      const accessBody = accessRes.json();
      assert.equal(accessBody.hasAccess, true);
      assert.equal(accessBody.accessType, 'full');
      assert.equal(accessBody.paymentStatus, 'paid');
      assert.equal(accessBody.reason, 'admin');

      const fullRes = await invokeServer(server, {
        method: 'GET',
        url: `/api/user/${adminId}/full`,
        headers: { 'X-Telegram-Init-Data': initData },
      });
      assert.equal(fullRes.status, 200);
      assert.equal(fullRes.json().success, true);
      if (adminId === 888002) {
        assert.equal(fullRes.json().data.paymentStatus, 'paid');
        assert.equal(fullRes.json().data.accessType, 'full');
      }
    }

    // 5. После удаления менеджера 888002 доступ откатывается к обычному unpaid
    await removeManager(888002, 777000, { db });
    const afterRemove = await getUserAccess(888002, { db });
    assert.equal(afterRemove.hasAccess, false);
    assert.equal(afterRemove.paymentStatus, 'unpaid');
  } finally {
    process.env.MAIN_ADMIN_ID = prevMainAdmin;
  }
});
