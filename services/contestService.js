// imantap_bot/services/contestService.js
import { getDB } from '../db.js';
import { ObjectId } from 'mongodb';

// ─── Cache ────────────────────────────────────────────────────────────────────
let _activeContestCache = null;
let _cacheTTL = 0;
const CACHE_MS = 60_000;

function invalidateCache() {
  _activeContestCache = null;
  _cacheTTL = 0;
}

// ─── Core ─────────────────────────────────────────────────────────────────────

export async function getActiveContest() {
  if (_activeContestCache && Date.now() < _cacheTTL) return _activeContestCache;
  const contest = await getDB().collection('contests').findOne({ status: 'active' });
  _activeContestCache = contest;
  _cacheTTL = Date.now() + CACHE_MS;
  return contest;
}

export async function getCurrentContest() {
  const active = await getActiveContest();
  if (active) return active;
  return getDB().collection('contests').findOne(
    { status: 'finished' },
    { sort: { endDate: -1 } }
  );
}

export async function createContest({ name, prize, startDate, endDate, prizePlaces, createdBy }) {
  const doc = {
    name, prize, startDate, endDate,
    prizePlaces: parseInt(prizePlaces),
    status: 'upcoming',
    winners: [],
    createdBy,
    createdAt: new Date(),
  };
  const result = await getDB().collection('contests').insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

export async function activateContest(contestId) {
  await getDB().collection('contests').updateOne(
    { _id: new ObjectId(contestId) },
    { $set: { status: 'active' } }
  );
  invalidateCache();
}

export async function addContestXp(userId, xpAmount) {
  const contest = await getActiveContest();
  if (!contest) return;

  const user = await getDB().collection('users').findOne(
    { userId: parseInt(userId) },
    { projection: { paymentStatus: 1 } }
  );
  if (!user || user.paymentStatus !== 'paid') return;

  await getDB().collection('contest_participants').updateOne(
    { contestId: contest._id, userId: parseInt(userId) },
    {
      $inc: { xp: xpAmount },
      $set: { updatedAt: new Date() },
      $setOnInsert: { contestId: contest._id, userId: parseInt(userId) },
    },
    { upsert: true }
  );
}

export async function getContestLeaderboard(contestId, limit = 50) {
  const cid = new ObjectId(contestId);
  const participants = await getDB().collection('contest_participants')
    .find({ contestId: cid })
    .sort({ xp: -1, updatedAt: 1 })
    .limit(limit)
    .toArray();

  if (!participants.length) return [];

  const userIds = participants.map(p => p.userId);
  const users = await getDB().collection('users')
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

export async function getUserContestRank(contestId, userId) {
  const cid = new ObjectId(contestId);
  const uid = parseInt(userId);
  const participant = await getDB().collection('contest_participants')
    .findOne({ contestId: cid, userId: uid });
  if (!participant) return { rank: null, xp: 0, xpToNext: null };

  const rank = await getDB().collection('contest_participants').countDocuments({
    contestId: cid,
    $or: [
      { xp: { $gt: participant.xp } },
      { xp: participant.xp, updatedAt: { $lt: participant.updatedAt } },
    ],
  }) + 1;

  const above = await getDB().collection('contest_participants').findOne(
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

export async function finalizeContest(contestId) {
  const cid = new ObjectId(contestId);
  const contest = await getDB().collection('contests').findOne({ _id: cid });
  if (!contest || contest.status === 'finished') return null;

  const leaderboard = await getContestLeaderboard(contestId, contest.prizePlaces);
  const winners = leaderboard.slice(0, contest.prizePlaces).map((p, i) => ({
    ...p, place: i + 1,
  }));

  await getDB().collection('contests').updateOne(
    { _id: cid },
    { $set: { status: 'finished', winners } }
  );
  invalidateCache();
  return { contest: { ...contest, status: 'finished', winners }, winners };
}

export async function checkMissedContests() {
  const db = getDB();
  const now = new Date();

  // Activate contests that should have started
  const toActivate = await db.collection('contests').find({
    status: 'upcoming',
    startDate: { $lt: now },
    endDate: { $gt: now },
  }).toArray();
  for (const c of toActivate) {
    console.log(`⚠️ Активируем пропущенный конкурс: ${c.name}`);
    await activateContest(c._id.toString());
  }

  // Finalize contests that should have ended
  const toFinalize = await db.collection('contests').find({
    status: 'active',
    endDate: { $lt: now },
  }).toArray();
  for (const c of toFinalize) {
    console.log(`⚠️ Финализируем пропущенный конкурс: ${c.name}`);
    try { await finalizeContest(c._id.toString()); }
    catch (err) { console.error(`❌ Ошибка финализации ${c._id}:`, err); }
  }

  return { activated: toActivate.length, finalized: toFinalize.length };
}

export async function getUpcomingAndActiveContests() {
  return getDB().collection('contests').find({
    status: { $in: ['upcoming', 'active'] },
    endDate: { $gt: new Date() },
  }).toArray();
}

export async function getContestById(contestId) {
  return getDB().collection('contests').findOne({ _id: new ObjectId(contestId) });
}
