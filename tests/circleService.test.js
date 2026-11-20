// tests/circleService.test.js
// Unit-тесты прав доступа кружков, защиты от дублирующегося вступления,
// выхода единственного владельца, $elemMatch и /api/circles/join.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';

process.env.MONGO_URL ??= 'mongodb://127.0.0.1:27017/imantap_test';

const {
  createCircle,
  getUserCircles,
  getCircleDetails,
  inviteToCircle,
  acceptInvite,
  declineInvite,
  joinByCode,
  leaveCircle,
  removeMember,
  deleteCircle,
} = await import('../services/circleService.js');
const { createApiServer } = await import('../apiServer.js');

const BOT_TOKEN = '123456:circles-test-token';

function createSignedInitData(userId) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAEAAAE',
    user: JSON.stringify({ id: userId, first_name: 'CircleUser' }),
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

function matchCondition(val, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof RegExp) && !Array.isArray(cond)) {
    if ('$regex' in cond) {
      return cond.$regex.test(String(val ?? ''));
    }
    if ('$in' in cond) {
      return cond.$in.includes(val);
    }
    if ('$ne' in cond) {
      return val !== cond.$ne;
    }
  }
  return val === cond;
}

function matchDoc(doc, filter) {
  let matchedArrayIndex = -1;
  for (const [key, cond] of Object.entries(filter)) {
    if (key === 'members' && cond && typeof cond === 'object' && '$elemMatch' in cond) {
      const idx = (doc.members || []).findIndex(m =>
        Object.entries(cond.$elemMatch).every(([mk, mv]) => matchCondition(m[mk], mv))
      );
      if (idx === -1) return { matched: false, idx: -1 };
      matchedArrayIndex = idx;
      continue;
    }
    if (key === 'members.userId') {
      const ids = (doc.members || []).map(m => m.userId);
      if (cond && typeof cond === 'object' && '$ne' in cond) {
        if (ids.includes(cond.$ne)) return { matched: false, idx: -1 };
      } else if (!ids.includes(cond)) {
        return { matched: false, idx: -1 };
      }
      continue;
    }
    if (!matchCondition(doc[key], cond)) return { matched: false, idx: -1 };
  }
  return { matched: true, idx: matchedArrayIndex };
}

function createFakeCirclesDb(initialUsers = [], initialCircles = []) {
  const users = initialUsers.map(u => structuredClone(u));
  const circles = initialCircles.map(c => structuredClone(c));
  let seq = 1;

  const makeCollection = (store) => ({
    async findOne(filter) {
      const found = store.find(d => matchDoc(d, filter).matched);
      return found ? structuredClone(found) : null;
    },
    find(filter = {}) {
      const items = store.filter(d => matchDoc(d, filter).matched).map(d => structuredClone(d));
      return { toArray: async () => items };
    },
    async insertOne(doc) {
      const copy = structuredClone(doc);
      copy._id = `id_${seq++}`;
      store.push(copy);
      return { insertedId: copy._id };
    },
    async updateOne(filter, update) {
      for (let i = 0; i < store.length; i++) {
        const res = matchDoc(store[i], filter);
        if (!res.matched) continue;
        const doc = store[i];
        if (update.$push) {
          for (const [k, v] of Object.entries(update.$push)) {
            if (!Array.isArray(doc[k])) doc[k] = [];
            doc[k].push(structuredClone(v));
          }
        }
        if (update.$set) {
          for (const [k, v] of Object.entries(update.$set)) {
            if (k.startsWith('members.$.')) {
              const field = k.slice('members.$.'.length);
              if (res.idx >= 0) doc.members[res.idx][field] = structuredClone(v);
            } else {
              doc[k] = structuredClone(v);
            }
          }
        }
        return { matchedCount: 1, modifiedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    },
    async deleteOne(filter) {
      const idx = store.findIndex(d => matchDoc(d, filter).matched);
      if (idx === -1) return { deletedCount: 0 };
      store.splice(idx, 1);
      return { deletedCount: 1 };
    },
  });

  return {
    collection(name) {
      if (name === 'users') return makeCollection(users);
      if (name === 'circles') return makeCollection(circles);
      throw new Error(`Unexpected collection: ${name}`);
    },
    rawCircles: () => structuredClone(circles),
  };
}

function seedUsers() {
  return [
    { userId: 101, username: '@owner', name: 'Owner', xp: 500, currentStreak: 3 },
    { userId: 202, username: '@member1', name: 'Member One', xp: 300, currentStreak: 2 },
    { userId: 303, username: '@member2', name: 'Member Two', xp: 200, currentStreak: 1 },
    { userId: 404, username: '@outsider', name: 'Outsider', xp: 100, currentStreak: 0 },
  ];
}

test('circle access control: only owner can invite, remove members, and delete circle', async () => {
  const db = createFakeCirclesDb(seedUsers());
  const { circle } = await createCircle(101, 'My Circle', 'Test desc', { db });

  // Member 202 joins via code
  await joinByCode(circle.inviteCode, 202, { db });

  // Non-owner cannot invite
  await assert.rejects(
    () => inviteToCircle(circle.circleId, 202, '@member2', { db }),
    /Only owner can invite/
  );

  // Non-owner cannot remove members
  await assert.rejects(
    () => removeMember(circle.circleId, 202, 101, { db }),
    /Only owner can remove members/
  );

  // Non-owner cannot delete circle
  await assert.rejects(
    () => deleteCircle(circle.circleId, 202, { db }),
    /Only owner can delete the circle/
  );

  // Non-member cannot view circle details
  await assert.rejects(
    () => getCircleDetails(circle.circleId, 404, { db }),
    /Access denied/
  );

  // Owner CAN invite, remove, and delete
  const invRes = await inviteToCircle(circle.circleId, 101, '@member2', { db });
  assert.equal(invRes.success, true);
  assert.equal(invRes.targetUserId, 303);

  const remRes = await removeMember(circle.circleId, 101, 202, { db });
  assert.equal(remRes.success, true);

  const delRes = await deleteCircle(circle.circleId, 101, { db });
  assert.equal(delRes.success, true);
  assert.equal(db.rawCircles().length, 0);
});

test('sole owner cannot leave circle or kick themselves', async () => {
  const db = createFakeCirclesDb(seedUsers());
  const { circle } = await createCircle(101, 'Solo Circle', '', { db });

  await assert.rejects(
    () => leaveCircle(circle.circleId, 101, { db }),
    /Owner cannot leave/
  );

  await assert.rejects(
    () => removeMember(circle.circleId, 101, 101, { db }),
    /Cannot remove yourself/
  );
});

test('duplicate join and duplicate invite are prevented; kicked member cannot bypass kick by code', async () => {
  const db = createFakeCirclesDb(seedUsers());
  const { circle } = await createCircle(101, 'NoDupes', '', { db });

  // Concurrent joinByCode for same user — only one succeeds, no duplicate members
  const results = await Promise.allSettled([
    joinByCode(circle.inviteCode, 202, { db }),
    joinByCode(circle.inviteCode, 202, { db }),
  ]);
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /Already a member/);

  let raw = db.rawCircles()[0];
  assert.equal(raw.members.filter(m => m.userId === 202).length, 1);

  // Owner kicks 202 -> status becomes 'removed'
  await removeMember(circle.circleId, 101, 202, { db });

  // Kicked user cannot rejoin via invite code directly
  await assert.rejects(
    () => joinByCode(circle.inviteCode, 202, { db }),
    /You were removed from this circle/
  );

  // Owner re-invites 202 -> updates existing member in place (no duplicate entry!)
  await inviteToCircle(circle.circleId, 101, 'member1', { db });
  raw = db.rawCircles()[0];
  assert.equal(raw.members.filter(m => m.userId === 202).length, 1);
  assert.equal(raw.members.find(m => m.userId === 202).status, 'pending');

  // Now 202 can accept invite
  await acceptInvite(circle.circleId, 202, { db });
  raw = db.rawCircles()[0];
  assert.equal(raw.members.find(m => m.userId === 202).status, 'active');
});

test('acceptInvite uses $elemMatch and respects maxMembers limit', async () => {
  const db = createFakeCirclesDb(seedUsers());
  const { circle } = await createCircle(101, 'Small Circle', '', { db });
  // Set maxMembers = 2 on stored circle
  const circlesCol = db.collection('circles');
  await circlesCol.updateOne({ circleId: circle.circleId }, { $set: { settings: { maxMembers: 2 } } });

  // Invite both 202 and 303 while space is available (1 active of 2)
  await inviteToCircle(circle.circleId, 101, '@member1', { db });
  await inviteToCircle(circle.circleId, 101, '@member2', { db });

  // Owner (active) calling acceptInvite must NOT match pending invite of 202/303
  await assert.rejects(
    () => acceptInvite(circle.circleId, 101, { db }),
    /Invite not found/
  );

  // 202 accepts -> now circle is 2/2 (full)
  await acceptInvite(circle.circleId, 202, { db });

  // 303 accepting now must fail with Circle is full
  await assert.rejects(
    () => acceptInvite(circle.circleId, 303, { db }),
    /Circle is full/
  );

  // 202 leaves and 303 declines -> verify getUserCircles excludes left & declined
  await leaveCircle(circle.circleId, 202, { db });
  await declineInvite(circle.circleId, 303, { db });
  assert.equal((await getUserCircles(202, { db })).length, 0);
  assert.equal((await getUserCircles(303, { db })).length, 0);
});

test('POST /api/circles/join notifies owner using getMiniAppDeepLink without ReferenceError', async () => {
  const db = createFakeCirclesDb(seedUsers());
  const { circle } = await createCircle(101, 'Api Circle', '', { db });

  const sentMessages = [];
  const server = createApiServer({
    bot: { sendMessage: async (chatId, text, opts) => { sentMessages.push({ chatId, text, opts }); } },
    botToken: BOT_TOKEN,
    getDb: () => db,
  });

  const res = await invokeServer(server, {
    method: 'POST',
    url: '/api/circles/join',
    headers: { 'X-Telegram-Init-Data': createSignedInitData(202) },
    body: JSON.stringify({ inviteCode: circle.inviteCode }),
  });

  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.success, true);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, 101);
  assert.match(sentMessages[0].text, /Api Circle/);
  assert.match(sentMessages[0].opts.reply_markup.inline_keyboard[0][0].url, /^https:\/\/t\.me\//);
});
