// tests/referralsAndContests.test.js
// Unit-тесты защиты рефералов от накрутки (включая mongodb@5.9.2 { value, ok }),
// защищённого роута GET /api/referrals и жизненного цикла конкурсов.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ObjectId } from 'mongodb';

process.env.MONGO_URL ??= 'mongodb://127.0.0.1:27017/imantap_test';

const {
  unwrapModifyResult,
  checkPromoCode,
  redeemReferralCode,
  getReferralStats,
  addReferralXP,
  claimReferralBonus,
  claimPaymentBonus,
  updateUserProgress,
} = await import('../userService.js');
const {
  createContest,
  activateContest,
  addContestXp,
  finalizeContest,
  getContestLeaderboard,
} = await import('../services/contestService.js');
const { createApiServer } = await import('../apiServer.js');

const BOT_TOKEN = '123456:referrals-test-token';
const BEFORE_EID_DATE = () => new Date('2026-03-10T10:00:00+05:00');

function createSignedInitData(userId) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAEAAAE',
    user: JSON.stringify({ id: userId, first_name: 'RefUser' }),
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

function cloneDoc(value) {
  if (value instanceof ObjectId) return new ObjectId(value.toHexString());
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(cloneDoc);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = cloneDoc(v);
    }
    return out;
  }
  return value;
}

function getNested(obj, path) {
  return path.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);
}

function setNested(obj, path, val) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = cloneDoc(val);
}

function incNested(obj, path, delta) {
  const prev = getNested(obj, path) || 0;
  setNested(obj, path, prev + delta);
}

function matchesMongoFilter(doc, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or') {
      if (!cond.some(sub => matchesMongoFilter(doc, sub))) return false;
      continue;
    }
    const val = getNested(doc, key);
    if (cond === null) {
      // В MongoDB { field: null } совпадает с null и отсутствующим полем (undefined)
      if (val !== null && val !== undefined) return false;
      continue;
    }
    if (cond instanceof ObjectId) {
      if (String(val) !== String(cond)) return false;
      continue;
    }
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      if ('$ne' in cond && val === cond.$ne) return false;
      if ('$in' in cond && !cond.$in.includes(val)) return false;
      if ('$gt' in cond && !(val > cond.$gt)) return false;
      if ('$lt' in cond && !(val < cond.$lt)) return false;
      if ('$lte' in cond && !(val <= cond.$lte)) return false;
      if ('$exists' in cond) {
        const exists = val !== undefined;
        if (exists !== cond.$exists) return false;
      }
      continue;
    }
    if (val !== cond) return false;
  }
  return true;
}

/**
 * In-memory MongoDB v5.9.2 mock:
 * findOneAndUpdate ВСЕГДА возвращает `{ value: doc | null, ok: 1 }`,
 * точно как официальный драйвер mongodb@5.9.2!
 */
function createMongoV5MockDb({ users = [], contests = [], participants = [] } = {}) {
  const stores = {
    users: users.map(u => cloneDoc(u)),
    contests: contests.map(c => cloneDoc(c)),
    contest_participants: participants.map(p => cloneDoc(p)),
  };

  function makeCollection(name) {
    const store = stores[name];
    return {
      async findOne(filter) {
        const doc = store.find(d => matchesMongoFilter(d, filter));
        return doc ? cloneDoc(doc) : null;
      },
      find(filter = {}) {
        let items = store.filter(d => matchesMongoFilter(d, filter)).map(d => cloneDoc(d));
        const cursor = {
          sort(spec) {
            const entries = Object.entries(spec);
            items.sort((a, b) => {
              for (const [k, dir] of entries) {
                const av = getNested(a, k);
                const bv = getNested(b, k);
                if (av === bv) continue;
                return av > bv ? dir : -dir;
              }
              return 0;
            });
            return cursor;
          },
          limit(n) { items = items.slice(0, n); return cursor; },
          project() { return cursor; },
          toArray: async () => items,
        };
        return cursor;
      },
      async countDocuments(filter = {}) {
        return store.filter(d => matchesMongoFilter(d, filter)).length;
      },
      async insertOne(doc) {
        const copy = cloneDoc(doc);
        if (!copy._id) copy._id = new ObjectId();
        store.push(copy);
        return { insertedId: copy._id };
      },
      async updateOne(filter, update, options = {}) {
        let doc = store.find(d => matchesMongoFilter(d, filter));
        if (!doc && options.upsert) {
          doc = {};
          if (update.$setOnInsert) {
            for (const [k, v] of Object.entries(update.$setOnInsert)) setNested(doc, k, v);
          }
          store.push(doc);
        }
        if (!doc) return { matchedCount: 0, modifiedCount: 0 };
        if (update.$set) {
          for (const [k, v] of Object.entries(update.$set)) setNested(doc, k, v);
        }
        if (update.$inc) {
          for (const [k, delta] of Object.entries(update.$inc)) incNested(doc, k, delta);
        }
        return { matchedCount: 1, modifiedCount: 1 };
      },
      async findOneAndUpdate(filter, update, options = {}) {
        const doc = store.find(d => matchesMongoFilter(d, filter));
        if (!doc) {
          // Точное поведение mongodb@5.9.2: возвращает объект { value: null, ok: 1 }, НЕ null!
          return { value: null, ok: 1, lastErrorObject: { n: 0, updatedExisting: false } };
        }
        const before = cloneDoc(doc);
        if (update.$set) {
          for (const [k, v] of Object.entries(update.$set)) setNested(doc, k, v);
        }
        if (update.$inc) {
          for (const [k, delta] of Object.entries(update.$inc)) incNested(doc, k, delta);
        }
        const value = options.returnDocument === 'after' ? cloneDoc(doc) : before;
        return { value, ok: 1, lastErrorObject: { n: 1, updatedExisting: true } };
      },
    };
  }

  return {
    collection(name) {
      if (!stores[name]) throw new Error(`Unexpected collection: ${name}`);
      return makeCollection(name);
    },
    getUser(userId) {
      return cloneDoc(stores.users.find(u => u.userId === userId));
    },
    getContests() {
      return cloneDoc(stores.contests);
    },
    getParticipants() {
      return cloneDoc(stores.contest_participants);
    },
  };
}

test('unwrapModifyResult properly unwraps mongodb@5.9.2 { value, ok } envelopes', () => {
  assert.deepEqual(unwrapModifyResult({ value: { userId: 1 }, ok: 1 }), { userId: 1 });
  assert.equal(unwrapModifyResult({ value: null, ok: 1 }), null);
  assert.equal(unwrapModifyResult(null), null);
  assert.deepEqual(unwrapModifyResult({ userId: 2 }), { userId: 2 });
});

test('claimReferralBonus and claimPaymentBonus are strictly single-use under mongodb@5.9.2', async () => {
  const db = createMongoV5MockDb({
    users: [{ userId: 500, promoCode: 'AAA111', referralBonusGiven: false, paymentBonusGiven: false }],
  });

  // Первый вызов — true, второй и последующие — строго false (несмотря на { value: null, ok: 1 })
  assert.equal(await claimReferralBonus(500, { db }), true);
  assert.equal(await claimReferralBonus(500, { db }), false);

  assert.equal(await claimPaymentBonus(500, { db }), true);
  assert.equal(await claimPaymentBonus(500, { db }), false);
});

test('referral anti-fraud: blocks self-referral, repeated redemption, and client sync reset', async () => {
  const db = createMongoV5MockDb({
    users: [
      {
        userId: 1001,
        promoCode: 'INV100',
        paymentStatus: 'paid',
        xp: 0,
        invitedCount: 0,
        hasRedeemedReferral: false,
        referredBy: null,
        usedPromoCode: null,
        location: { timezone: 'Asia/Almaty' },
      },
      {
        userId: 2002,
        promoCode: 'USR200',
        paymentStatus: 'unpaid',
        xp: 0,
        invitedCount: 0,
        hasRedeemedReferral: false,
        referredBy: null,
        usedPromoCode: null,
        location: { timezone: 'Asia/Almaty' },
        progress: {},
        preparationProgress: {},
        basicProgress: {},
        syncVersion: 0,
      },
    ],
  });

  // 1. Самореферал запрещён в checkPromoCode, redeemReferralCode и addReferralXP
  assert.deepEqual(await checkPromoCode('INV100', 1001, { db }), { valid: false, reason: 'own_code' });
  assert.deepEqual(await checkPromoCode('INV100', '1001', { db }), { valid: false, reason: 'own_code' });
  assert.deepEqual(
    await redeemReferralCode(1001, 'INV100', { db }),
    { success: false, reason: 'own_code' }
  );
  assert.deepEqual(
    await addReferralXP(1001, 'registration', 1001, 'Self', { db, nowFn: BEFORE_EID_DATE, addContestXp: async () => {} }),
    { success: false, reason: 'self_referral' }
  );

  // 2. Повторный и параллельный ввод промокода: только первый succeeds, выставляется hasRedeemedReferral
  const [r1, r2] = await Promise.all([
    redeemReferralCode(2002, 'inv100', { db, source: 'promo', requirePaidOwner: true }),
    redeemReferralCode(2002, 'INV100', { db, source: 'promo', requirePaidOwner: true }),
  ]);
  assert.equal([r1, r2].filter(r => r.success).length, 1);
  assert.equal([r1, r2].filter(r => r.reason === 'already_redeemed').length, 1);
  assert.equal(db.getUser(2002).hasRedeemedReferral, true);
  assert.equal(db.getUser(2002).usedPromoCode, 'INV100');

  // Повторный checkPromoCode также возвращает already_redeemed
  assert.deepEqual(
    await checkPromoCode('INV100', 2002, { db }),
    { valid: false, reason: 'already_redeemed' }
  );

  // 3. Клиентский sync (updateUserProgress) НЕ может сбросить hasRedeemedReferral обратно в false
  await updateUserProgress(2002, { hasRedeemedReferral: false, syncVersion: 0 }, { db, addContestXp: async () => {} });
  assert.equal(db.getUser(2002).hasRedeemedReferral, true);
});

test('addReferralXP atomically increments invitedCount and applies daily multiplier under mongodb@5.9.2', async () => {
  const db = createMongoV5MockDb({
    users: [
      {
        userId: 1001,
        promoCode: 'INV100',
        paymentStatus: 'paid',
        xp: 0,
        invitedCount: 0,
        dailyReferrals: {},
        location: { timezone: 'Asia/Almaty' },
      },
    ],
  });

  // 5 параллельных регистраций рефералов — 5-й должен получить множитель 1.3x (130 XP)
  const results = await Promise.all(
    [2001, 2002, 2003, 2004, 2005].map(refId =>
      addReferralXP(1001, 'registration', refId, `User ${refId}`, {
        db,
        nowFn: BEFORE_EID_DATE,
        addContestXp: async () => {},
      })
    )
  );

  assert.equal(results.every(r => r.success), true);
  const fifth = results.find(r => r.todayCount === 5);
  assert.ok(fifth, '5th referral must have todayCount === 5');
  assert.equal(fifth.multiplier, 1.3);
  assert.equal(fifth.xp, 130);

  const inviter = db.getUser(1001);
  assert.equal(inviter.invitedCount, 5);
  assert.equal(inviter.xp, 4 * 100 + 130);
});

test('GET /api/referrals requires Telegram auth, enforces ownership, and returns own stats', async () => {
  const db = createMongoV5MockDb({
    users: [
      { userId: 1001, promoCode: 'OWN100', invitedCount: 2, hasRedeemedReferral: false, referredBy: null, usedPromoCode: null },
      { userId: 2001, promoCode: 'REF201', referredBy: 'OWN100', paymentStatus: 'paid', name: 'Ali', createdAt: new Date('2026-03-01') },
      { userId: 2002, promoCode: 'REF202', usedPromoCode: 'OWN100', paymentStatus: 'unpaid', name: 'Aida', createdAt: new Date('2026-03-02') },
    ],
  });

  const server = createApiServer({
    bot: { sendMessage: async () => {} },
    botToken: BOT_TOKEN,
    getDb: () => db,
  });

  // Без initData -> 401
  const unauth = await invokeServer(server, { url: '/api/referrals' });
  assert.equal(unauth.status, 401);

  // Чужой промокод -> 403
  const forbidden = await invokeServer(server, {
    url: '/api/referrals?code=REF201',
    headers: { 'X-Telegram-Init-Data': createSignedInitData(1001) },
  });
  assert.equal(forbidden.status, 403);

  // Свои данные (без ?code и со своим ?code) -> 200
  const ok = await invokeServer(server, {
    url: '/api/referrals?code=own100',
    headers: { 'X-Telegram-Init-Data': createSignedInitData(1001) },
  });
  assert.equal(ok.status, 200);
  const payload = ok.json();
  assert.equal(payload.success, true);
  assert.equal(payload.data.promoCode, 'OWN100');
  assert.equal(payload.data.invitedCount, 2);
  assert.equal(payload.data.paidCount, 1);
  assert.equal(payload.data.referrals.length, 2);

  // Также проверяем getReferralStats напрямую
  const direct = await getReferralStats(1001, { db });
  assert.equal(direct.ok, true);
  assert.equal(direct.data.paidCount, 1);
});

test('contest lifecycle: validates dates, prevents re-activation, double finalization, and post-endDate XP', async () => {
  const db = createMongoV5MockDb({
    users: [
      { userId: 1001, name: 'Paid User', paymentStatus: 'paid' },
      { userId: 1002, name: 'Free User', paymentStatus: 'unpaid' },
    ],
  });

  // Невалидные даты (endDate <= startDate)
  await assert.rejects(
    () => createContest({
      name: 'Invalid',
      prize: 'Gift',
      startDate: new Date('2026-05-10T00:00:00Z'),
      endDate: new Date('2026-05-01T00:00:00Z'),
      prizePlaces: 3,
      createdBy: 1,
    }, { db }),
    /endDate must be after startDate/
  );

  const contest = await createContest({
    name: 'Ramadan Cup',
    prize: 'Umrah',
    startDate: new Date('2026-05-01T00:00:00Z'),
    endDate: new Date('2026-05-10T00:00:00Z'),
    prizePlaces: 2,
    createdBy: 1,
  }, { db });

  // Активация работает только один раз (upcoming -> active)
  assert.equal(await activateContest(contest._id.toString(), { db }), true);
  assert.equal(await activateContest(contest._id.toString(), { db }), false);

  // XP начисляется только paid-пользователю до endDate
  await addContestXp(1001, 250, { db, nowFn: () => new Date('2026-05-05T00:00:00Z') });
  await addContestXp(1002, 250, { db, nowFn: () => new Date('2026-05-05T00:00:00Z') });
  // После endDate XP не добавляется даже до cron-финализации
  await addContestXp(1001, 999, { db, nowFn: () => new Date('2026-05-11T00:00:00Z') });

  const lb = await getContestLeaderboard(contest._id.toString(), 10, { db });
  assert.equal(lb.length, 1);
  assert.equal(lb[0].userId, 1001);
  assert.equal(lb[0].xp, 250);

  // Параллельная финализация — только один вызов возвращает результат, второй null
  const [fin1, fin2] = await Promise.all([
    finalizeContest(contest._id.toString(), { db }),
    finalizeContest(contest._id.toString(), { db }),
  ]);
  const nonNull = [fin1, fin2].filter(Boolean);
  assert.equal(nonNull.length, 1);
  assert.equal(nonNull[0].winners.length, 1);

  // Завершённый конкурс нельзя повторно активировать
  assert.equal(await activateContest(contest._id.toString(), { db }), false);
});
