import http from 'http';
import { getDB } from './db.js';
import {
  getUserAccess, updateUserProgress, getUserFullData,
  getFriendsLeaderboard, getCities, getFilteredLeaderboard,
} from './userService.js';
import {
  createCircle, getUserCircles, getCircleDetails, inviteToCircle,
  acceptInvite, declineInvite, joinByCode, leaveCircle, removeMember, deleteCircle,
} from './services/circleService.js';
import {
  getCurrentContest, getContestLeaderboard, getUserContestRank,
} from './services/contestService.js';
import { SHAWWAL_START_DATE, SHAWWAL_END_DATE } from './config.js';
import { getKazakhstanCities } from './utils/cityMapping.js';
import { verifyTelegramInitData } from './utils/telegramAuth.js';

export function startApiServer({ bot, port, miniAppUrl, checkRateLimit }) {
  const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  
  // ✅ РАСШИРЕННЫЕ CORS (включая Telegram origins)
  const allowedOrigins = [
    'https://imantap-production-6776.up.railway.app',
    'https://web.telegram.org',
    'https://z.t.me',
    'https://telegram.org'
  ];
  
  // Разрешаем в dev режиме
  if (process.env.NODE_ENV !== 'production') {
    allowedOrigins.push('http://localhost:3000', 'http://localhost:5173');
  }
  
  const origin = req.headers.origin || req.headers.referer;
  
  // ✅ КРИТИЧНО: Telegram WebApp может не отправлять origin
  const isTelegramRequest = !origin || 
                           origin?.includes('t.me') || 
                           origin?.includes('telegram') ||
                           origin?.includes('railway.app');
  
  if (isTelegramRequest || allowedOrigins.some(allowed => origin?.includes(allowed))) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    // НЕ блокируем, просто логируем
    console.log('⚠️ Unknown origin:', origin);
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  
  // OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Telegram-Init-Data');
    res.statusCode = 200;
    res.end();
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
    const telegramAuth = isProtectedApi
      ? verifyTelegramInitData(req.headers['x-telegram-init-data'], process.env.BOT_TOKEN, maxInitDataAgeSeconds)
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
        try {
          const progressData = JSON.parse(body);
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
        } catch (parseError) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
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
        const limit = parseInt(url.searchParams.get('limit') || '20');
        
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
        const limit = parseInt(url.searchParams.get('limit')) || 50;
        const offset = parseInt(url.searchParams.get('offset')) || 0;
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

    // ─── Contest API ────────────────────────────────────────────────────────
    if (url.pathname === '/api/contest/current') {
      try {
        const requestedUserId = parseInt(url.searchParams.get('userId'));
        if (requestedUserId && !requireCurrentUser(requestedUserId)) return;
        const userId = authUserId;
        const contest = await getCurrentContest();
        if (!contest) {
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, data: null }));
          return;
        }
        const participant = userId
          ? await getUserContestRank(contest._id.toString(), userId)
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
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
        const leaderboard = await getContestLeaderboard(contestId, limit);
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
          
          const result = await createCircle(userId, name, description);
          
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
        
        const circles = await getUserCircles(userId);
        
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
        
        const details = await getCircleDetails(circleId, userId);
        
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, data: details }));
      } catch (error) {
        console.error('❌ API Error /circles/details:', error);
        res.statusCode = 500;
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
          
          const result = await inviteToCircle(circleId, inviterId, targetUsername);
          
          // ✅ ДОБАВИТЬ: Отправка уведомления в Telegram
          if (result.success && result.targetUserId) {
            try {
              const miniAppUrl = `https://t.me/${process.env.BOT_USERNAME}/${process.env.MINI_APP_NAME}`;
              
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
          res.statusCode = 400;
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
          
          const result = await acceptInvite(circleId, userId);

          // ✅ ДОБАВИТЬ: Уведомление владельцу о принятии приглашения
          if (result.success) {
            try {
              const db = await getDB();
              const circles = db.collection('circles');
              const users = db.collection('users');
              
              const circle = await circles.findOne({ circleId });
              const acceptingUser = await users.findOne({ userId: parseInt(userId) });
              
              if (circle && acceptingUser) {
                const miniAppUrl = `https://t.me/${process.env.BOT_USERNAME}/${process.env.MINI_APP_NAME}`;
                
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
          
          const result = await leaveCircle(circleId, userId);

          // ✅ ДОБАВИТЬ: Уведомление владельцу о выходе участника
          if (result.success) {
            try {
              const db = await getDB();
              const circles = db.collection('circles');
              const users = db.collection('users');
              
              const circle = await circles.findOne({ circleId });
              const leavingUser = await users.findOne({ userId: parseInt(userId) });
              
              if (circle && leavingUser) {
                const miniAppUrl = `https://t.me/${process.env.BOT_USERNAME}/${process.env.MINI_APP_NAME}`;
                
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
          
          const result = await removeMember(circleId, ownerId, targetUserId);

          // ✅ ДОБАВИТЬ: Уведомление удаленному участнику
          if (result.success) {
            try {
              const db = await getDB();
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
          res.statusCode = 400;
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
          
          const result = await deleteCircle(circleId, ownerId);
          
          res.statusCode = 200;
          res.end(JSON.stringify(result));
        } catch (error) {
          console.error('❌ API Error /circles/delete:', error.message);
          res.statusCode = 400;
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
          
          const result = await declineInvite(circleId, userId);
          
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
          
          const result = await joinByCode(inviteCode, userId);

          // ✅ ДОБАВИТЬ: Уведомление владельцу о новом участнике
          try {
            const joiningUser = await db.collection('users').findOne({ userId: parseInt(userId) });
            const miniAppUrl = `https://t.me/${process.env.BOT_USERNAME}/${process.env.MINI_APP_NAME}`;
            
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
    if (req.method === 'POST' && req.url === '/shawwal-fast') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { date } = JSON.parse(body);
          const userId = authUserId;

          const db = getDB();
          const users = db.collection('users');
          const user = await users.findOne({ userId: Number(userId) });

          if (!user) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'User not found' }));
          }

          // ✅ userTZ объявляем ДО использования
          const userTZ = user.location?.timezone || 'Asia/Almaty';
          const todayStr = date || new Date().toLocaleDateString('en-CA', { timeZone: userTZ });

          if (todayStr < SHAWWAL_START_DATE || todayStr > SHAWWAL_END_DATE) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Not shawwal period' }));
          }

          const shawwalDates = user.shawwalDates || [];
          const currentFasts = user.shawwalFasts || 0;

          // ✅ Уже отмечен
          if (shawwalDates.includes(todayStr)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ 
              success: true, 
              alreadyMarked: true,
              shawwalFasts: currentFasts,
              shawwalDates: shawwalDates
            }));
          }

          // ✅ Уже 6
          if (currentFasts >= 6) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ 
              success: true, 
              shawwalFasts: 6, 
              shawwalDates: shawwalDates,
              completed: true 
            }));
          }

          const newCount = currentFasts + 1;
          const newDates = [...shawwalDates, todayStr];

          await users.updateOne(
            { userId: Number(userId) },
            { 
              $set: { shawwalFasts: newCount },
              $inc: { xp: 60 },
              $push: { shawwalDates: todayStr }
            }
          );

          console.log(`⭐ +60 XP Shawwal → User ${userId} (${newCount}/6) [${todayStr}]`);

          if (newCount === 6) {
            const lang = user.language || 'kk';
            const congratsMsg = lang === 'kk'
              ? `🎉 *МашаАллаһ! Шәууал оразасын аяқтадыңыз!*\n\n6 күн ораза ұстадыңыз — бұл 1 жылдық оразаға тең сауап! 🤲\n\nАлла Тағала барлық амалдарыңызды қабыл етсін! 🌙`
              : `🎉 *МашаАллаh! Вы завершили пост Шавваля!*\n\n6 дней поста — награда, равная году поста! 🤲\n\nПусть Аллах примет все ваши деяния! 🌙`;
            try {
              await bot.sendMessage(user.userId, congratsMsg, { parse_mode: 'Markdown' });
            } catch (e) {
              console.error('Ошибка поздравления:', e.message);
            }
          }

          // ✅ Возвращаем shawwalDates для синхронизации фронта
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: true, 
            alreadyMarked: false,
            shawwalFasts: newCount,
            shawwalDates: newDates,
            completed: newCount === 6
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

// Запуск сервера
server.listen(port, () => {
  console.log(`✅ HTTP API Server running on port ${port}`);
  console.log(`✅ Bot started successfully`);
  console.log(`✅ Mini App URL: ${miniAppUrl}`);
});

}
