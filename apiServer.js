import http from 'http';
import { getDB } from './db.js';
import {
  getUserAccess, updateUserProgress, getUserFullData,
  getFriendsLeaderboard, getCities, getFilteredLeaderboard,
  getReferralStats,
} from './userService.js';
import {
  createCircle, getUserCircles, getCircleDetails, inviteToCircle,
  acceptInvite, declineInvite, joinByCode, leaveCircle, removeMember, deleteCircle,
} from './services/circleService.js';
import {
  getCurrentContest, getContestLeaderboard, getUserContestRank,
} from './services/contestService.js';
import { SHAWWAL_START_DATE, SHAWWAL_END_DATE, SHAWWAL_FASTS, getMiniAppDeepLink } from './config.js';
import { getKazakhstanCities } from './utils/cityMapping.js';
import { verifyTelegramInitData } from './utils/telegramAuth.js';

const TELEGRAM_ALLOWED_ORIGINS = [
  'https://web.telegram.org',
  'https://webk.telegram.org',
  'https://webz.telegram.org',
  'https://telegram.org',
  'https://z.t.me',
];

const DEV_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

function normalizeOrigin(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function buildAllowedOrigins({
  miniAppUrl = process.env.MINI_APP_URL,
  nodeEnv = process.env.NODE_ENV,
  extraOrigins = process.env.CORS_ALLOWED_ORIGINS,
} = {}) {
  const allowed = new Set(TELEGRAM_ALLOWED_ORIGINS);

  const normalizedMiniAppOrigin = normalizeOrigin(miniAppUrl);
  if (normalizedMiniAppOrigin) {
    allowed.add(normalizedMiniAppOrigin);
  }

  if (typeof extraOrigins === 'string' && extraOrigins.trim()) {
    for (const raw of extraOrigins.split(',')) {
      const normalized = normalizeOrigin(raw);
      if (normalized) allowed.add(normalized);
    }
  }

  if (nodeEnv !== 'production') {
    for (const devOrigin of DEV_ALLOWED_ORIGINS) {
      allowed.add(devOrigin);
    }
  }

  return allowed;
}

export function applyCorsHeaders(req, res, allowedOrigins) {
  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';

  if (!originHeader) {
    // Non-browser clients or native WebViews without Origin header:
    // never emit Access-Control-Allow-Origin: * together with credentials.
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Telegram-Init-Data');
      res.statusCode = 204;
      res.end();
      return { handled: true, allowed: true };
    }
    return { handled: false, allowed: true };
  }

  res.setHeader('Vary', 'Origin');

  if (allowedOrigins.has(originHeader)) {
    res.setHeader('Access-Control-Allow-Origin', originHeader);
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Telegram-Init-Data');
      res.setHeader('Access-Control-Max-Age', '86400');
      res.statusCode = 204;
      res.end();
      return { handled: true, allowed: true };
    }
    return { handled: false, allowed: true };
  }

  console.warn('⚠️ Blocked CORS origin:', originHeader);
  if (req.method === 'OPTIONS') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 403;
    res.end(JSON.stringify({ success: false, error: 'CORS origin not allowed' }));
    return { handled: true, allowed: false };
  }
  return { handled: false, allowed: false };
}

export function createApiServer({
  bot,
  port = 8080,
  miniAppUrl = process.env.MINI_APP_URL,
  checkRateLimit = () => true,
  botToken,
  nodeEnv = process.env.NODE_ENV,
  extraOrigins = process.env.CORS_ALLOWED_ORIGINS,
  getDb = getDB,
  nowFn = () => new Date(),
} = {}) {
  const allowedOrigins = buildAllowedOrigins({ miniAppUrl, nodeEnv, extraOrigins });

  return http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);

  const corsResult = applyCorsHeaders(req, res, allowedOrigins);
  if (corsResult.handled) {
    return;
  }
  
  // Устанавливаем Content-Type для всех ответов
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    // Health check
    if (url.pathname === '/health') {
      res.statusCode = 200;
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }

    // Every Mini App request is authenticated with Telegram's signed initData.
    // userId from URL/body is only a routing value and must match this identity.
    const isProtectedApi = url.pathname.startsWith('/api/') || url.pathname === '/shawwal-fast';
    const maxInitDataAgeSeconds = Number(process.env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS) || 24 * 60 * 60;
    const effectiveBotToken = botToken ?? process.env.BOT_TOKEN;
    const telegramAuth = isProtectedApi
      ? verifyTelegramInitData(req.headers['x-telegram-init-data'], effectiveBotToken, maxInitDataAgeSeconds)
      : null;
    if (isProtectedApi && !telegramAuth) {
      res.statusCode = 401;
      res.end(JSON.stringify({ success: false, error: 'Unauthorized Telegram Mini App request' }));
      return;
    }
    const authUserId = telegramAuth?.userId;

    const requireCurrentUser = (requestedUserId) => {
      if (Number(requestedUserId) === authUserId) return true;
      res.statusCode = 403;
      res.end(JSON.stringify({ success: false, error: 'You can only access your own data' }));
      return false;
    };

    // ✅ API: /api/check-access (для фронтенда miniapp)
    if (url.pathname === '/api/check-access') {
      const userId = parseInt(url.searchParams.get('userId'));
      
      if (!userId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'userId required' }));
        return;
      }
      if (!requireCurrentUser(userId)) return;
      
      try {
        const access = await getUserAccess(userId);
        console.log(`✅ API /check-access: userId=${userId}, hasAccess=${access.hasAccess}, status=${access.paymentStatus}`);
        
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          hasAccess: access.hasAccess,
          paymentStatus: access.paymentStatus,
          demoExpires: access.demoExpires,
          reason: access.reason
        }));
        return;
      } catch (error) {
        console.error('❌ API Error /check-access:', error);
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: error.message }));
        return;
      }
    }

    // API: Проверка доступа пользователя
    if (url.pathname.match(/^\/api\/user\/\d+\/access$/)) {
      const userId = parseInt(url.pathname.split('/')[3]);
      
      if (!userId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'Invalid userId' }));
        return;
      }
      if (!requireCurrentUser(userId)) return;

      try {
        const access = await getUserAccess(userId);
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          hasAccess: access.hasAccess,
          paymentStatus: access.paymentStatus,
          demoExpires: access.demoExpires
        }));
        return;
      } catch (error) {
        console.error('❌ API Error /access:', error);
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
        return;
      }
    }

    // API: Sync данных пользователя (POST)
    if (url.pathname.match(/^\/api\/user\/\d+\/sync$/) && req.method === 'POST') {
      const userId = parseInt(url.pathname.split('/')[3]);
      
      if (!userId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'Invalid userId' }));
        return;
      }
      if (!requireCurrentUser(userId)) return;

      // 🔒 ЗАЩИТА: не более 10 запросов в минуту на одного юзера
      if (!checkRateLimit(userId, 10)) {
        res.statusCode = 429;
        res.end(JSON.stringify({ success: false, error: 'Too many requests' }));
        return;
      }

      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      
      req.on('end', async () => {
        let progressData;
        try {
          progressData = JSON.parse(body);
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
          return;
        }

        if (!progressData || typeof progressData !== 'object' || Array.isArray(progressData)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Invalid payload' }));
          return;
        }

        try {
          const result = await updateUserProgress(userId, progressData);

          if (result?.conflict) {
            const updatedData = await getUserFullData(userId);
            res.statusCode = 409;
            res.end(JSON.stringify({
              success: false,
              conflict: true,
              data: updatedData,
              syncVersion: result.syncVersion,
            }));
            return;
          }

          if (result && result.success) {
            console.log(`✅ Синк для ${userId}, начислено: ${result.xpAdded} XP`);
            const updatedData = await getUserFullData(userId);
            res.statusCode = 200;
            res.end(JSON.stringify({ 
              success: true, 
              data: updatedData,
              xpAdded: result.xpAdded || 0,
              streakMultiplier: result.streakMultiplier || 1.0
            }));
          } else {
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: 'Failed to update progress' }));
          }
        } catch (error) {
          console.error('❌ API Error /sync:', error);
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
        }
      });
      
      return;
    }

    // API: Получить данные пользователя
    if (url.pathname === '/api/user') {
      const userId = parseInt(url.searchParams.get('userId'));
      if (!userId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'userId required' }));
        return;
      }
      if (!requireCurrentUser(userId)) return;

      const userData = await getUserFullData(userId);
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, data: userData }));
      return;
    }

    // ✅ API: Получить полные данные пользователя
    if (url.pathname.match(/^\/api\/user\/\d+\/full$/)) {
      const userId = parseInt(url.pathname.split('/')[3]);
      
      if (!userId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'userId required' }));
        return;
      }
      if (!requireCurrentUser(userId)) return;
      
      try {
        const userData = await getUserFullData(userId);
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, data: userData }));
        return;
      } catch (error) {
        console.error('❌ API Error /user/full:', error);
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
        return;
      }
    }

    // ✅ API: Лидерборд друзей
    if (url.pathname.match(/^\/api\/leaderboard\/friends\/\d+$/)) {
      try {
        const userId = parseInt(url.pathname.split('/')[4]);
        const rawLimit = parseInt(url.searchParams.get('limit') || '20', 10);
        const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1), 100);
        
        if (!userId) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'userId required' }));
          return;
        }
        if (!requireCurrentUser(userId)) return;
        
        const friends = await getFriendsLeaderboard(userId, limit);
        
        res.statusCode = 200;
        res.end(JSON.stringify({ 
          success: true, 
          data: friends,
          total: friends.length,
          hasMore: false  // ✅ Для friends всегда false (нет пагинации)
        }));
        return;
      } catch (error) {
        console.error('❌ API Error /leaderboard/friends:', error);
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
        return;
      }
    }

    // API: countries - только Казахстан
    if (url.pathname === '/api/leaderboard/countries') {
      try {
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, data: ['Kazakhstan'] }));
        return;
      } catch (error) {
        console.error('API Error (countries):', error);
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
        return;
      }
    }

    // API: cities - список областных центров с количеством пользователей
    if (url.pathname === '/api/leaderboard/cities') {
      try {
        const country = url.searchParams.get('country');
        
        if (country === 'Kazakhstan' || !country) {
          const db = getDB();
          const users = db.collection('users');
          
          // ✅ Получаем список только областных центров
          const regionalCenters = getKazakhstanCities();
          
          // ✅ Считаем пользователей только для этих городов
          const cityCounts = await users.aggregate([
            { 
              $match: { 
                'location.country': 'Kazakhstan',
                'location.city': { $in: regionalCenters } // ← только из списка!
              } 
            },
            {
              $group: {
                _id: '$location.city',
                count: { $sum: 1 }
              }
            },
            {
              $sort: { count: -1 } // Сортируем по количеству
            }
          ]).toArray();
          
          // ✅ Создаём Map для быстрого поиска
          const cityCountMap = new Map(
            cityCounts.map(item => [item._id, item.count])
          );
          
          // ✅ Формируем полный список (даже если пользователей 0)
          const citiesWithCount = regionalCenters.map(city => ({
            city: city,
            count: cityCountMap.get(city) || 0
          }));
          
          // ✅ Сортируем по количеству (убывание)
          citiesWithCount.sort((a, b) => b.count - a.count);
          
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, data: citiesWithCount }));
          return;
        }
        
        // Для других стран (на будущее)
        const cities = await getCities(country);
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, data: cities }));
        return;
      } catch (error) {
        console.error('API Error (cities):', error);
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
        return;
      }
    }

    // API: Лидерборд с фильтрами (обновлённый /api/leaderboard/global)
    if (url.pathname === '/api/leaderboard/global') {
      try {
        const rawLimit = parseInt(url.searchParams.get('limit') || '50', 10);
        const rawOffset = parseInt(url.searchParams.get('offset') || '0', 10);
        const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 100);
        const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);
        const country = url.searchParams.get('country') || null;
        const city = url.searchParams.get('city') || null;
        
        const result = await getFilteredLeaderboard({ limit, offset, country, city });
        
        res.statusCode = 200;
        res.end(JSON.stringify({ 
          success: true, 
          data: result.data,
          total: result.total,
          hasMore: result.hasMore
        }));
        return;
      } catch (error) {
        console.error('❌ API Error /leaderboard/global:', error);
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
        return;
      }
    }

    // ─── Referrals API ──────────────────────────────────────────────────────
    if (url.pathname === '/api/referrals' && req.method === 'GET') {
      try {
        const promoCode = url.searchParams.get('code');
        const result = await getReferralStats(authUserId, { promoCode, db: getDb() });
        if (!result.ok) {
          res.statusCode = result.status || 400;
          res.end(JSON.stringify({ success: false, error: result.error }));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, data: result.data }));
        return;
      } catch (err) {
        console.error('❌ API /api/referrals:', err);
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
        return;
      }
    }

    // ─── Contest API ────────────────────────────────────────────────────────
    if (url.pathname === '/api/contest/current') {
      try {
        const requestedUserId = parseInt(url.searchParams.get('userId'));
        if (requestedUserId && !requireCurrentUser(requestedUserId)) return;
        const userId = authUserId;
        const dbDeps = getDb !== getDB ? { db: getDb() } : {};
        const contest = await getCurrentContest(dbDeps);
        if (!contest) {
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, data: null }));
          return;
        }
        const participant = userId
          ? await getUserContestRank(contest._id.toString(), userId, dbDeps)
          : { rank: null, xp: 0, xpToNext: null };
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, data: { contest, participant } }));
        return;
      } catch (err) {
        console.error('❌ API /api/contest/current:', err);
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
        return;
      }
    }

    if (url.pathname.match(/^\/api\/contest\/[a-f0-9]{24}\/leaderboard$/)) {
      try {
        const contestId = url.pathname.split('/')[3];
        const rawLimit = parseInt(url.searchParams.get('limit') || '50', 10);
        const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 100);
        const dbDeps = getDb !== getDB ? { db: getDb() } : {};
        const leaderboard = await getContestLeaderboard(contestId, limit, dbDeps);
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, data: leaderboard }));
        return;
      } catch (err) {
        console.error('❌ API /api/contest/:id/leaderboard:', err);
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
        return;
      }
    }

    // API: Создать круг
    if (url.pathname === '/api/circles/create' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      
      req.on('end', async () => {
        try {
          const { name, description } = JSON.parse(body);
          const userId = authUserId;
          
          const result = await createCircle(userId, name, description, { db: getDb() });
          
          res.statusCode = 200;
          res.end(JSON.stringify(result));
        } catch (error) {
          console.error('❌ API Error /circles/create:', error);
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: error.message }));
        }
      });
      
      return;
    }

    // API: Получить круги пользователя
    if (url.pathname.match(/^\/api\/circles\/user\/\d+$/)) {
      try {
        const userId = url.pathname.split('/')[4];
        if (!requireCurrentUser(userId)) return;
        
        const circles = await getUserCircles(userId, { db: getDb() });
        
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, data: circles }));
      } catch (error) {
        console.error('❌ API Error /circles/user:', error);
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
      }
      
      return;
    }

    // API: Получить детали круга с прогрессом
    if (url.pathname.startsWith('/api/circles/') && url.pathname.endsWith('/details')) {
      try {
        const circleId = url.pathname.split('/')[3];
        const userId = url.searchParams.get('userId');
        
        if (!userId) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'userId required' }));
          return;
        }
        if (!requireCurrentUser(userId)) return;
        
        const details = await getCircleDetails(circleId, userId, { db: getDb() });
        
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, data: details }));
      } catch (error) {
        console.error('❌ API Error /circles/details:', error);
        if (error.message === 'Access denied') res.statusCode = 403;
        else if (error.message === 'Circle not found') res.statusCode = 404;
        else res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
      
      return;
    }

    // API: Пригласить пользователя
    if (url.pathname === '/api/circles/invite' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      
      req.on('end', async () => {
        try {
          const { circleId, targetUsername } = JSON.parse(body);
          const inviterId = authUserId;
          
          console.log('🔍 INVITE REQUEST:', {
            circleId,
            inviterId,
            targetUsername
          });
          
          const result = await inviteToCircle(circleId, inviterId, targetUsername, { db: getDb() });
          
          // ✅ ДОБАВИТЬ: Отправка уведомления в Telegram
          if (result.success && result.targetUserId) {
            try {
              const miniAppUrl = getMiniAppDeepLink();
              
              const message = 
                `👋 <b>${result.inviterUsername}</b> сізді топқа шақырды!\n\n` +
                `🤝 <b>${result.circleName}</b>\n` +
                (result.circleDescription ? `📝 ${result.circleDescription}\n` : '') +
                `👥 ${result.memberCount} адам\n\n` +
                `Шақыруды қабылдау үшін ImanTap ашыңыз 👇`;

              await bot.sendMessage(result.targetUserId, message, {
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [[
                    {
                      text: 'ImanTap ашу',
                      url: miniAppUrl
                    }
                  ]]
                }
              });
              
              console.log(`📬 Уведомление отправлено пользователю ${result.targetUserId}`);
            } catch (notifyError) {
              console.error('❌ Ошибка отправки уведомления:', notifyError.message);
              // Не прерываем выполнение если уведомление не отправилось
            }
          }
          
          res.statusCode = 200;
          res.end(JSON.stringify(result));
        } catch (error) {
          console.error('❌ API Error /circles/invite:', error.message);
          if (error.message === 'Only owner can invite') res.statusCode = 403;
          else if (error.message === 'Circle not found') res.statusCode = 404;
          else res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: error.message }));
        }
      });
      
      return;
    }

    // API: Принять приглашение
    if (url.pathname === '/api/circles/accept' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      
      req.on('end', async () => {
        try {
          const { circleId } = JSON.parse(body);
          const userId = authUserId;
          
          const db = getDb();
          const result = await acceptInvite(circleId, userId, { db });

          // ✅ ДОБАВИТЬ: Уведомление владельцу о принятии приглашения
          if (result.success) {
            try {
              const circles = db.collection('circles');
              const users = db.collection('users');
              
              const circle = await circles.findOne({ circleId });
              const acceptingUser = await users.findOne({ userId: parseInt(userId) });
              
              if (circle && acceptingUser) {
                const miniAppUrl = getMiniAppDeepLink();
                
                const message = 
                  `✅ <b>Шақыру қабылданды!</b>\n\n` +
                  `👤 <b>${acceptingUser.name}</b> <b>"${circle.name}"</b> тобына қосылды\n\n` +
                  `👥 Қазір қатысушылар: ${circle.members.filter(m => m.status === 'active').length}`;
                
                await bot.sendMessage(circle.ownerId, message, {
                  parse_mode: 'HTML',
                  reply_markup: {
                    inline_keyboard: [[
                      {
                        text: '👀 Топты ашу',
                        url: miniAppUrl
                      }
                    ]]
                  }
                });
                
                console.log(`📬 Уведомление о принятии приглашения отправлено владельцу ${circle.ownerId}`);
              }
            } catch (notifyError) {
              console.error('❌ Ошибка отправки уведомления:', notifyError.message);
            }
          }
          
          res.statusCode = 200;
          res.end(JSON.stringify(result));
        } catch (error) {
          console.error('❌ API Error /circles/accept:', error);
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: error.message }));
        }
      });
      
      return;
    }

    // API: Выйти из круга
    if (url.pathname === '/api/circles/leave' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      
      req.on('end', async () => {
        try {
          const { circleId } = JSON.parse(body);
          const userId = authUserId;
          
          console.log('🔍 LEAVE REQUEST:', { circleId, userId });
          
          const db = getDb();
          const result = await leaveCircle(circleId, userId, { db });

          // ✅ ДОБАВИТЬ: Уведомление владельцу о выходе участника
          if (result.success) {
            try {
              const circles = db.collection('circles');
              const users = db.collection('users');
              
              const circle = await circles.findOne({ circleId });
              const leavingUser = await users.findOne({ userId: parseInt(userId) });
              
              if (circle && leavingUser) {
                const miniAppUrl = getMiniAppDeepLink();
                
                const message = 
                  `🚪 <b>Қатысушы топтан шықты</b>\n\n` +
                  `👤 <b>${leavingUser.name}</b> <b>"${circle.name}"</b> тобынан шықты\n\n` +
                  `👥 Қалған қатысушылар: ${circle.members.filter(m => m.status === 'active').length}`;
                
                await bot.sendMessage(circle.ownerId, message, {
                  parse_mode: 'HTML',
                  reply_markup: {
                    inline_keyboard: [[
                      {
                        text: '👀 Топты ашу',
                        url: miniAppUrl
                      }
                    ]]
                  }
                });
                
                console.log(`📬 Уведомление о выходе отправлено владельцу ${circle.ownerId}`);
              }
            } catch (notifyError) {
              console.error('❌ Ошибка отправки уведомления:', notifyError.message);
            }
          }
          
          res.statusCode = 200;
          res.end(JSON.stringify(result));
        } catch (error) {
          console.error('❌ API Error /circles/leave:', error.message);
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: error.message }));
        }
      });
      
      return;
    }

    // API: Удалить участника из круга
    if (url.pathname === '/api/circles/remove-member' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      
      req.on('end', async () => {
        try {
          const { circleId, targetUserId } = JSON.parse(body);
          const ownerId = authUserId;
          
          console.log('🔍 REMOVE MEMBER REQUEST:', { circleId, ownerId, targetUserId });
          
          const db = getDb();
          const result = await removeMember(circleId, ownerId, targetUserId, { db });

          // ✅ ДОБАВИТЬ: Уведомление удаленному участнику
          if (result.success) {
            try {
              const circles = db.collection('circles');
              
              const circle = await circles.findOne({ circleId });
              
              if (circle) {
                const message = 
                  `❌ <b>Сіз топтан шығарылдыңыз</b>\n\n` +
                  `Иесі сізді <b>"${circle.name}"</b> тобынан шығарды\n\n` +
                  `Сіз бұл топтың қатысушысы емессіз.`;
                
                await bot.sendMessage(parseInt(targetUserId), message, {
                  parse_mode: 'HTML'
                });
                
                console.log(`📬 Уведомление об удалении отправлено пользователю ${targetUserId}`);
              }
            } catch (notifyError) {
              console.error('❌ Ошибка отправки уведомления:', notifyError.message);
            }
          }
          
          res.statusCode = 200;
          res.end(JSON.stringify(result));
        } catch (error) {
          console.error('❌ API Error /circles/remove-member:', error.message);
          if (error.message === 'Only owner can remove members') res.statusCode = 403;
          else if (error.message === 'Circle not found') res.statusCode = 404;
          else res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: error.message }));
        }
      });
      
      return;
    }

    // API: Удалить круг
    if (url.pathname === '/api/circles/delete' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      
      req.on('end', async () => {
        try {
          const { circleId } = JSON.parse(body);
          const ownerId = authUserId;
          
          console.log('🔍 DELETE CIRCLE REQUEST:', { circleId, ownerId });
          
          const result = await deleteCircle(circleId, ownerId, { db: getDb() });
          
          res.statusCode = 200;
          res.end(JSON.stringify(result));
        } catch (error) {
          console.error('❌ API Error /circles/delete:', error.message);
          if (error.message === 'Only owner can delete the circle') res.statusCode = 403;
          else if (error.message === 'Circle not found') res.statusCode = 404;
          else res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: error.message }));
        }
      });
      
      return;
    }

    // API: Отклонить приглашение
    if (url.pathname === '/api/circles/decline' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      
      req.on('end', async () => {
        try {
          const { circleId } = JSON.parse(body);
          const userId = authUserId;
          
          const result = await declineInvite(circleId, userId, { db: getDb() });
          
          res.statusCode = 200;
          res.end(JSON.stringify(result));
        } catch (error) {
          console.error('❌ API Error /circles/decline:', error);
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: error.message }));
        }
      });
      
      return;
    }

    // API: Присоединиться по коду
    if (url.pathname === '/api/circles/join' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      
      req.on('end', async () => {
        try {
          const { inviteCode } = JSON.parse(body);
          const userId = authUserId;
          
          console.log('🔗 JOIN REQUEST:', { inviteCode, userId });
          
          const db = getDb();
          const result = await joinByCode(inviteCode, userId, { db });

          // ✅ Уведомление владельцу о новом участнике
          if (result.success && result.circle) {
            try {
              const updatedCircle = result.circle;
              const joiningUser = await db.collection('users').findOne({ userId: parseInt(userId) });
              const miniAppUrl = getMiniAppDeepLink();
              
              const message = 
                `🎉 <b>Топқа жаңа адам қосылды!</b>\n\n` +
                `👤 <b>${joiningUser?.name || 'қатысушы'}</b> <b>"${updatedCircle.name}"</b> тобына қосылды\n\n` +
                `👥 Қазір қатысушылар: ${updatedCircle.members.filter(m => m.status === 'active').length}`;
              
              await bot.sendMessage(updatedCircle.ownerId, message, {
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [[
                    {
                      text: '👀 Топты ашу',
                      url: miniAppUrl
                    }
                  ]]
                }
              });
              
              console.log(`📬 Уведомление о присоединении отправлено владельцу ${updatedCircle.ownerId}`);
            } catch (notifyError) {
              console.error('❌ Ошибка отправки уведомления:', notifyError.message);
            }
          }
          
          res.statusCode = 200;
          res.end(JSON.stringify(result));
        } catch (error) {
          console.error('❌ API Error /circles/join:', error.message);
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: error.message }));
        }
      });
      
      return;
    }

    // =====================================================
    // 🌙 SHAWWAL — отметить пост
    // =====================================================
    if (req.method === 'POST' && url.pathname === '/shawwal-fast') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          let parsed = {};
          if (body && body.trim()) {
            try {
              parsed = JSON.parse(body);
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            }
          }
          const rawDate = parsed?.date;
          const userId = Number(authUserId);

          if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
            const m = typeof rawDate === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(rawDate.trim()) : null;
            if (!m) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'Invalid date format' }));
            }
            const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
            const check = new Date(Date.UTC(y, mo - 1, d));
            if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'Invalid calendar date' }));
            }
          }

          const db = getDb();
          const users = db.collection('users');
          const user = await users.findOne({ userId });

          if (!user) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'User not found' }));
          }

          // ✅ userTZ с безопасным фолбэком на Asia/Almaty
          const userTZ = user.location?.timezone || 'Asia/Almaty';
          let userTodayStr;
          try {
            userTodayStr = nowFn().toLocaleDateString('en-CA', { timeZone: userTZ });
          } catch {
            userTodayStr = nowFn().toLocaleDateString('en-CA', { timeZone: 'Asia/Almaty' });
          }
          const targetDate = (typeof rawDate === 'string' && rawDate.trim()) ? rawDate.trim() : userTodayStr;

          if (targetDate < SHAWWAL_START_DATE || targetDate > SHAWWAL_END_DATE) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Not shawwal period' }));
          }

          if (targetDate > userTodayStr) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Cannot mark future date' }));
          }

          // Атомарное обновление защищает от гонки (double-tap / бот + mini app)
          // и корректно обрабатывает пользователей без поля shawwalFasts в документе.
          const atomicResult = await users.findOneAndUpdate(
            {
              userId,
              shawwalDates: { $ne: targetDate },
              $or: [
                { shawwalFasts: { $lt: SHAWWAL_FASTS } },
                { shawwalFasts: { $exists: false } },
                { shawwalFasts: null },
              ],
            },
            {
              $inc: { shawwalFasts: 1, xp: 60 },
              $addToSet: { shawwalDates: targetDate },
            },
            { returnDocument: 'after', includeResultMetadata: false }
          );

          const updatedUser =
            atomicResult && typeof atomicResult === 'object' && 'value' in atomicResult
              ? atomicResult.value
              : atomicResult;

          if (!updatedUser) {
            const freshUser = await users.findOne({ userId }) || user;
            const freshDates = Array.isArray(freshUser.shawwalDates) ? freshUser.shawwalDates : [];
            const freshFasts = freshUser.shawwalFasts || 0;

            if (freshDates.includes(targetDate)) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                success: true,
                alreadyMarked: true,
                shawwalFasts: freshFasts,
                shawwalDates: freshDates,
                completed: freshFasts >= SHAWWAL_FASTS,
              }));
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: true,
              alreadyMarked: false,
              shawwalFasts: freshFasts,
              shawwalDates: freshDates,
              completed: freshFasts >= SHAWWAL_FASTS,
            }));
          }

          const newCount = updatedUser.shawwalFasts;
          const newDates = Array.isArray(updatedUser.shawwalDates) ? updatedUser.shawwalDates : [targetDate];

          console.log(`⭐ +60 XP Shawwal → User ${userId} (${newCount}/${SHAWWAL_FASTS}) [${targetDate}]`);

          if (newCount === SHAWWAL_FASTS) {
            const lang = updatedUser.language || user.language || 'kk';
            const congratsMsg = lang === 'kk'
              ? `🎉 *МашаАллаһ! Шәууал оразасын аяқтадыңыз!*\n\n${SHAWWAL_FASTS} күн ораза ұстадыңыз — бұл 1 жылдық оразаға тең сауап! 🤲\n\nАлла Тағала барлық амалдарыңызды қабыл етсін! 🌙`
              : `🎉 *МашаАллаh! Вы завершили пост Шавваля!*\n\n${SHAWWAL_FASTS} дней поста — награда, равная году поста! 🤲\n\nПусть Аллах примет все ваши деяния! 🌙`;
            try {
              await bot.sendMessage(user.userId, congratsMsg, { parse_mode: 'Markdown' });
            } catch (e) {
              console.error('Ошибка поздравления:', e.message);
            }
          }

          // ✅ Возвращаем shawwalDates и xp для синхронизации фронта
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            alreadyMarked: false,
            shawwalFasts: newCount,
            shawwalDates: newDates,
            xp: updatedUser.xp,
            completed: newCount >= SHAWWAL_FASTS,
          }));

        } catch (e) {
          console.error('Shawwal fast error:', e);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Server error' }));
        }
      });
      return;
    }

    // 404 для всех остальных путей
    res.statusCode = 404;
    res.end(JSON.stringify({ success: false, error: 'Not Found' }));

  } catch (error) {
    console.error('❌ API Error:', error);
    res.statusCode = 500;
    res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
  }
});
}

export function startApiServer({ bot, port, miniAppUrl, checkRateLimit }) {
  if (!process.env.BOT_USERNAME?.trim() || !process.env.MINI_APP_NAME?.trim()) {
    console.warn(
      `⚠️ BOT_USERNAME или MINI_APP_NAME не заданы в .env — для Telegram-диплинков используется фолбэк: ${getMiniAppDeepLink()}`
    );
  }

  if (process.env.NODE_ENV === 'production' && !normalizeOrigin(miniAppUrl || process.env.MINI_APP_URL)) {
    console.warn('⚠️ MINI_APP_URL не задан или некорректен — CORS может блокировать запросы Mini App');
  }

  const server = createApiServer({ bot, port, miniAppUrl, checkRateLimit });

  // Запуск сервера
  server.listen(port, () => {
    console.log(`✅ HTTP API Server running on port ${port}`);
    console.log(`✅ Bot started successfully`);
    console.log(`✅ Mini App URL: ${miniAppUrl}`);
  });

  return server;
}
