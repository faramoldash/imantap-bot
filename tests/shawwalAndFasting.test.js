import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

process.env.MONGO_URL ??= 'mongodb://127.0.0.1:27017/imantap_test';

const {
  PREPARATION_START_DATE,
  RAMADAN_START_DATE,
  FIRST_TARAWEEH_DATE,
  EID_AL_FITR_DATE,
  SHAWWAL_START_DATE,
  SHAWWAL_END_DATE,
  SHAWWAL_FASTS,
} = await import('../config.js');
const { isMondayOrThursday } = await import('../userService.js');
const { createApiServer } = await import('../apiServer.js');

const BOT_TOKEN = '123456:shawwal-test-token';

function createSignedInitData(userId) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAEAAAE',
    user: JSON.stringify({ id: userId, first_name: 'Iman' }),
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return params.toString();
}

function invokeServer(server, { method = 'POST', url = '/shawwal-fast', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    );

    const responseHeaders = new Map();
    let statusCode = 200;
    let rawBody = '';

    const res = {
      get statusCode() { return statusCode; },
      set statusCode(code) { statusCode = code; },
      setHeader(name, value) { responseHeaders.set(name.toLowerCase(), String(value)); },
      getHeader(name) { return responseHeaders.get(name.toLowerCase()); },
      writeHead(code, extraHeaders = {}) {
        statusCode = code;
        for (const [k, v] of Object.entries(extraHeaders)) {
          responseHeaders.set(k.toLowerCase(), String(v));
        }
      },
      end(chunk = '') {
        if (chunk) rawBody += String(chunk);
        resolve({
          status: statusCode,
          text: rawBody,
          json() { return JSON.parse(rawBody); },
        });
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

function matchesShawwalFilter(doc, filter) {
  if (!doc) return false;
  if (filter.userId !== undefined && doc.userId !== filter.userId) return false;
  if (filter.shawwalDates?.$ne !== undefined) {
    const arr = Array.isArray(doc.shawwalDates) ? doc.shawwalDates : [];
    if (arr.includes(filter.shawwalDates.$ne)) return false;
  }
  if (Array.isArray(filter.$or)) {
    const orMatched = filter.$or.some(cond => {
      if (cond.shawwalFasts?.$lt !== undefined) {
        return typeof doc.shawwalFasts === 'number' && doc.shawwalFasts < cond.shawwalFasts.$lt;
      }
      if (cond.shawwalFasts?.$exists === false) {
        return !Object.prototype.hasOwnProperty.call(doc, 'shawwalFasts');
      }
      if (cond.shawwalFasts === null) {
        return doc.shawwalFasts === null;
      }
      return false;
    });
    if (!orMatched) return false;
  }
  return true;
}

function createInMemoryUsersDb(initialUsers, { wrapModifyResult = false } = {}) {
  const store = new Map(initialUsers.map(u => [u.userId, structuredClone(u)]));
  const collection = {
    async findOne(filter) {
      const doc = store.get(filter.userId);
      return doc ? structuredClone(doc) : null;
    },
    async findOneAndUpdate(filter, update, options = {}) {
      const doc = store.get(filter.userId);
      if (!matchesShawwalFilter(doc, filter)) {
        return wrapModifyResult && options.includeResultMetadata !== false
          ? { value: null, ok: 1 }
          : null;
      }
      if (update.$inc) {
        for (const [k, delta] of Object.entries(update.$inc)) {
          doc[k] = (typeof doc[k] === 'number' ? doc[k] : 0) + delta;
        }
      }
      if (update.$addToSet) {
        for (const [k, val] of Object.entries(update.$addToSet)) {
          if (!Array.isArray(doc[k])) doc[k] = [];
          if (!doc[k].includes(val)) doc[k].push(val);
        }
      }
      const after = structuredClone(doc);
      return wrapModifyResult && options.includeResultMetadata !== false
        ? { value: after, ok: 1 }
        : after;
    },
  };
  return {
    store,
    getDb: () => ({ collection: () => collection }),
  };
}

test('isMondayOrThursday handles valid dates, extreme timezones, invalid timezones, and invalid calendar dates', () => {
  // 2026-02-09 is Monday, 2026-02-12 is Thursday
  assert.equal(isMondayOrThursday('2026-02-09', 'Asia/Almaty'), true);
  assert.equal(isMondayOrThursday('2026-02-12', 'Asia/Almaty'), true);
  assert.equal(isMondayOrThursday('2026-03-23', 'America/New_York'), true);
  assert.equal(isMondayOrThursday('2026-03-26', 'Pacific/Kiritimati'), true); // UTC+14
  assert.equal(isMondayOrThursday('2026-02-09', 'Pacific/Auckland'), true);   // UTC+13

  // Non-Mon/Thu
  assert.equal(isMondayOrThursday('2026-02-10', 'Asia/Almaty'), false); // Tue
  assert.equal(isMondayOrThursday('2026-02-11', 'Asia/Almaty'), false); // Wed
  assert.equal(isMondayOrThursday('2026-03-20', 'Asia/Almaty'), false); // Fri (Eid al-Fitr)
  assert.equal(isMondayOrThursday('2026-03-22', 'Asia/Almaty'), false); // Sun

  // Invalid timezone must not throw
  assert.equal(isMondayOrThursday('2026-02-09', 'Invalid/Timezone'), true);
  assert.equal(isMondayOrThursday('2026-02-10', 'Invalid/Timezone'), false);

  // Invalid date formats / non-existent calendar dates
  assert.equal(isMondayOrThursday('2026-02-30', 'Asia/Almaty'), false);
  assert.equal(isMondayOrThursday('2026-03-21-hack', 'Asia/Almaty'), false);
  assert.equal(isMondayOrThursday('', 'Asia/Almaty'), false);
  assert.equal(isMondayOrThursday(null, 'Asia/Almaty'), false);
});

test('frontend constants.ts seasonal & Shawwal constants stay synchronized with backend config.js', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const constantsPath = path.resolve(__dirname, '../../imantap mini app/constants.ts');
  const content = fs.readFileSync(constantsPath, 'utf8');

  const expectedStrings = {
    PREPARATION_START_DATE,
    RAMADAN_START_DATE,
    FIRST_TARAWEEH_DATE,
    EID_AL_FITR_DATE,
    SHAWWAL_START_DATE,
    SHAWWAL_END_DATE,
  };
  for (const [name, expected] of Object.entries(expectedStrings)) {
    const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*['"]${expected}['"]`);
    assert.match(content, re, `Expected ${name} = '${expected}' in constants.ts`);
  }
  assert.match(
    content,
    new RegExp(`export\\s+const\\s+SHAWWAL_FASTS\\s*=\\s*${SHAWWAL_FASTS}\\b`),
    `Expected SHAWWAL_FASTS = ${SHAWWAL_FASTS} in constants.ts`
  );
});

test('POST /shawwal-fast validates JSON, date format, Shawwal bounds, and future dates', async () => {
  const { getDb } = createInMemoryUsersDb([
    { userId: 101, language: 'ru', xp: 100, location: { timezone: 'Asia/Almaty' } },
  ]);
  const server = createApiServer({
    bot: { sendMessage: async () => {} },
    botToken: BOT_TOKEN,
    checkRateLimit: () => true,
    getDb,
    nowFn: () => new Date('2026-03-22T10:00:00Z'), // 2026-03-22 15:00 in Almaty
  });
  const headers = {
    'Content-Type': 'application/json',
    'X-Telegram-Init-Data': createSignedInitData(101),
  };

  // Malformed JSON
  const badJson = await invokeServer(server, { headers, body: '{bad' });
  assert.equal(badJson.status, 400);

  // Suffix hack trying to spoof Shawwal range
  const spoofDate = await invokeServer(server, {
    headers,
    body: JSON.stringify({ date: '2026-03-21-hack' }),
  });
  assert.equal(spoofDate.status, 400);

  // Impossible calendar date
  const badCal = await invokeServer(server, {
    headers,
    body: JSON.stringify({ date: '2026-02-30' }),
  });
  assert.equal(badCal.status, 400);

  // Outside Shawwal (Eid day & after end)
  const eidRes = await invokeServer(server, {
    headers,
    body: JSON.stringify({ date: EID_AL_FITR_DATE }),
  });
  assert.equal(eidRes.status, 400);

  const afterRes = await invokeServer(server, {
    headers,
    body: JSON.stringify({ date: '2026-04-20' }),
  });
  assert.equal(afterRes.status, 400);

  // Future Shawwal day (today is 2026-03-22)
  const futureRes = await invokeServer(server, {
    headers,
    body: JSON.stringify({ date: '2026-03-25' }),
  });
  assert.equal(futureRes.status, 400);
});

test('POST /shawwal-fast handles legacy users without shawwalFasts, prevents double-award, and caps at 6 fasts', async () => {
  const sentMessages = [];
  const { store, getDb } = createInMemoryUsersDb([
    // Legacy user document: no shawwalFasts / shawwalDates fields at all
    { userId: 202, language: 'kk', xp: 500, location: { timezone: 'Asia/Almaty' } },
  ]);
  const server = createApiServer({
    bot: { sendMessage: async (uid, msg) => sentMessages.push({ uid, msg }) },
    botToken: BOT_TOKEN,
    checkRateLimit: () => true,
    getDb,
    nowFn: () => new Date('2026-03-30T10:00:00Z'),
  });
  const headers = {
    'Content-Type': 'application/json',
    'X-Telegram-Init-Data': createSignedInitData(202),
  };

  // Concurrent double-tap for the same day must award +60 XP only once
  const [r1, r2] = await Promise.all([
    invokeServer(server, { headers, body: JSON.stringify({ date: '2026-03-21' }) }),
    invokeServer(server, { headers, body: JSON.stringify({ date: '2026-03-21' }) }),
  ]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const j1 = r1.json();
  const j2 = r2.json();
  assert.equal([j1.alreadyMarked, j2.alreadyMarked].filter(Boolean).length, 1);
  assert.equal(store.get(202).shawwalFasts, 1);
  assert.equal(store.get(202).xp, 560);

  // Complete remaining 5 fasts (days 2..6)
  for (const d of ['2026-03-22', '2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26']) {
    const res = await invokeServer(server, { headers, body: JSON.stringify({ date: d }) });
    assert.equal(res.status, 200);
  }

  assert.equal(store.get(202).shawwalFasts, SHAWWAL_FASTS);
  assert.equal(store.get(202).xp, 500 + SHAWWAL_FASTS * 60);
  assert.equal(sentMessages.length, 1);

  // 7th fast attempt must NOT award XP or exceed 6
  const seventh = await invokeServer(server, {
    headers,
    body: JSON.stringify({ date: '2026-03-27' }),
  });
  assert.equal(seventh.status, 200);
  assert.equal(seventh.json().completed, true);
  assert.equal(seventh.json().shawwalFasts, SHAWWAL_FASTS);
  assert.equal(store.get(202).shawwalFasts, SHAWWAL_FASTS);
  assert.equal(store.get(202).xp, 500 + SHAWWAL_FASTS * 60);
  assert.equal(sentMessages.length, 1);
});
