// imantap_bot/services/contestService.js
import { getDB } from '../db.js';
import { ObjectId } from 'mongodb';

// ─── Cache ────────────────────────────────────────────────────────────────────
let _activeContestCache = null;
let _cacheTTL = 0;
const CACHE_MS = 60_000;

export function invalidateCache() {
  _activeContestCache = null;
  _cacheTTL = 0;
}

function toObjectId(contestId) {
  if (contestId instanceof ObjectId) return contestId;
  if (typeof contestId !== 'string' || !ObjectId.isValid(contestId)) {
    return null;
  }
  return new ObjectId(contestId);
}

// ─── Core ─────────────────────────────────────────────────────────────────────

export async function getActiveContest(deps = {}) {
  const useCache = !deps.db;
  if (useCache && _activeContestCache && Date.now() < _cacheTTL) return _activeContestCache;
  const db = deps.db || getDB();
  const contest = await db.collection('contests').findOne({ status: 'active' });
  if (useCache) {
    _activeContestCache = contest;
    _cacheTTL = Date.now() + CACHE_MS;
  }
  return contest;
}

export async function getCurrentContest(deps = {}) {
  const active = await getActiveContest(deps);
  if (active) return active;
  const db = deps.db || getDB();
  return db.collection('contests').findOne(
    { status: 'finished' },
    { sort: { endDate: -1 } }
  );
}

export async function createContest({ name, prize, startDate, endDate, prizePlaces, createdBy }, deps = {}) {
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const trimmedPrize = typeof prize === 'string' ? prize.trim() : '';
  if (!trimmedName || !trimmedPrize) {
    throw new Error('Contest name and prize are required');
  }
  const start = startDate instanceof Date ? startDate : new Date(startDate);
  const end = endDate instanceof Date ? endDate : new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new Error('Contest endDate must be after startDate');
  }
  const places = parseInt(prizePlaces, 10);
  if (!Number.isInteger(places) || places < 1 || places > 100) {
    throw new Error('prizePlaces must be between 1 and 100');
  }

  const db = deps.db || getDB();
  const doc = {
    name: trimmedName,
    prize: trimmedPrize,
    startDate: start,
    endDate: end,
    prizePlaces: places,
    status: 'upcoming',
    winners: [],
    createdBy,
    createdAt: new Date(),
  };
  const result = await db.collection('contests').insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

export async function activateContest(contestId, deps = {}) {
  const cid = toObjectId(contestId);
  if (!cid) return false;
  const db = deps.db || getDB();
  const res = await db.collection('contests').updateOne(
    { _id: cid, status: 'upcoming' },
    { $set: { status: 'active', activatedAt: new Date() } }
  );
  if (!deps.db) invalidateCache();
  return res.modifiedCount > 0;
}

export async function addContestXp(userId, xpAmount, deps = {}) {
  if (!Number.isFinite(xpAmount) || xpAmount <= 0) return;
  const contest = await getActiveContest(deps);
  if (!contest) return;

  const now = deps.nowFn ? deps.nowFn() : new Date();
  if (contest.endDate && now.getTime() >= new Date(contest.endDate).getTime()) {
    return;
  }

  const db = deps.db || getDB();
  const uid = parseInt(userId, 10);
  if (!Number.isInteger(uid)) return;

  const user = await db.collection('users').findOne(
    { userId: uid },
    { projection: { paymentStatus: 1 } }
  );
  if (!user || user.paymentStatus !== 'paid') return;

  await db.collection('contest_participants').updateOne(
    { contestId: contest._id, userId: uid },
    {
      $inc: { xp: xpAmount },
      $set: { updatedAt: now },
      $setOnInsert: { contestId: contest._id, userId: uid },
    },
    { upsert: true }
  );
}

export async function getContestLeaderboard(contestId, limit = 50, deps = {}) {
  const cid = toObjectId(contestId);
  if (!cid) return [];
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), 100);
  const db = deps.db || getDB();

  const participants = await db.collection('contest_participants')
    .find({ contestId: cid })
    .sort({ xp: -1, updatedAt: 1 })
    .limit(safeLimit)
    .toArray();

  if (!participants.length) return [];

  const userIds = participants.map(p => p.userId);
  const users = await db.collection('users')
    .find({ userId: { $in: userIds } }, { projection: { userId: 1, name: 1, username: 1, photoUrl: 1 } })
    .toArray();
  const userMap = Object.fromEntries(users.map(u => [u.userId, u]));

  return participants.map((p, i) => ({
    rank: i + 1,
    userId: p.userId,
    name: userMap[p.userId]?.name || userMap[p.userId]?.username || 'Пользователь',
    username: userMap[p.userId]?.username || null,
    photoUrl: userMap[p.userId]?.photoUrl || null,
    xp: p.xp,
  }));
}

export async function getUserContestRank(contestId, userId, deps = {}) {
  const cid = toObjectId(contestId);
  const uid = parseInt(userId, 10);
  if (!cid || !Number.isInteger(uid)) return { rank: null, xp: 0, xpToNext: null };
  const db = deps.db || getDB();

  const participant = await db.collection('contest_participants')
    .findOne({ contestId: cid, userId: uid });
  if (!participant) return { rank: null, xp: 0, xpToNext: null };

  const rank = await db.collection('contest_participants').countDocuments({
    contestId: cid,
    $or: [
      { xp: { $gt: participant.xp } },
      { xp: participant.xp, updatedAt: { $lt: participant.updatedAt } },
    ],
  }) + 1;

  const above = await db.collection('contest_participants').findOne(
    {
      contestId: cid,
      $or: [
        { xp: { $gt: participant.xp } },
        { xp: participant.xp, updatedAt: { $lt: participant.updatedAt } },
      ],
    },
    { sort: { xp: 1, updatedAt: -1 } }
  );
  const xpToNext = above ? Math.max(above.xp - participant.xp, 1) : null;

  return { rank, xp: participant.xp, xpToNext };
}

export async function finalizeContest(contestId, deps = {}) {
  const cid = toObjectId(contestId);
  if (!cid) return null;
  const db = deps.db || getDB();

  const contest = await db.collection('contests').findOne({ _id: cid });
  if (!contest || contest.status === 'finished') return null;

  const leaderboard = await getContestLeaderboard(cid, contest.prizePlaces, deps);
  const winners = leaderboard.slice(0, contest.prizePlaces).map((p, i) => ({
    ...p, place: i + 1,
  }));

  const now = deps.nowFn ? deps.nowFn() : new Date();
  const updateRes = await db.collection('contests').updateOne(
    { _id: cid, status: { $ne: 'finished' } },
    { $set: { status: 'finished', winners, finishedAt: now } }
  );
  if (updateRes.modifiedCount === 0) return null;

  if (!deps.db) invalidateCache();
  return { contest: { ...contest, status: 'finished', winners, finishedAt: now }, winners };
}

export async function checkMissedContests(deps = {}) {
  const db = deps.db || getDB();
  const now = deps.nowFn ? deps.nowFn() : new Date();

  // Activate contests that should have started and haven't ended yet
  const toActivate = await db.collection('contests').find({
    status: 'upcoming',
    startDate: { $lt: now },
    endDate: { $gt: now },
  }).toArray();
  let activated = 0;
  for (const c of toActivate) {
    console.log(`⚠️ Активируем пропущенный конкурс: ${c.name}`);
    if (await activateContest(c._id.toString(), deps)) {
      activated++;
    }
  }

  // Finalize active or stale upcoming contests whose endDate has already passed
  const toFinalize = await db.collection('contests').find({
    status: { $in: ['active', 'upcoming'] },
    endDate: { $lte: now },
  }).toArray();
  let finalized = 0;
  for (const c of toFinalize) {
    console.log(`⚠️ Финализируем пропущенный конкурс: ${c.name}`);
    try {
      const res = await finalizeContest(c._id.toString(), deps);
      if (res) finalized++;
    } catch (err) {
      console.error(`❌ Ошибка финализации ${c._id}:`, err);
    }
  }

  return { activated, finalized };
}

export async function getUpcomingAndActiveContests(deps = {}) {
  const db = deps.db || getDB();
  const now = deps.nowFn ? deps.nowFn() : new Date();
  return db.collection('contests').find({
    status: { $in: ['upcoming', 'active'] },
    endDate: { $gt: now },
  }).toArray();
}

export async function getContestById(contestId, deps = {}) {
  const cid = toObjectId(contestId);
  if (!cid) return null;
  const db = deps.db || getDB();
  return db.collection('contests').findOne({ _id: cid });
}
