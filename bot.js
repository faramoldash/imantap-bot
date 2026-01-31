// bot.js
import TelegramBot from 'node-telegram-bot-api';
import http from 'http';
import dotenv from 'dotenv';
import { connectDB } from './db.js';
import {
  getOrCreateUser,
  getUserById,
  getUserByPromoCode,
  incrementReferralCount
} from './userService.js';

dotenv.config();

// Валидация переменных окружения
if (!process.env.BOT_TOKEN) {
  throw new Error('❌ BOT_TOKEN не указан в .env файле');
}

const token = process.env.BOT_TOKEN;
const MINI_APP_URL = "https://imantap-production-6776.up.railway.app";
const PORT = process.env.PORT || 3000;

// Создаём бота с polling и явным удалением webhook
const bot = new TelegramBot(token, { 
  polling: {
    interval: 1000,
    autoStart: true,
    params: {
      timeout: 10
    }
  }
});

// Удаляем webhook если был установлен
bot.deleteWebHook().then(() => {
  console.log('✅ Webhook удалён, используется polling');
}).catch(() => {
  console.log('ℹ️ Webhook не был установлен, используется polling');
});


// Подключение к MongoDB
await connectDB();

// ===== КОМАНДЫ БОТА =====

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const from = msg.from;
  const userId = from?.id;
  const param = match && match[1] ? match[1] : null;

  if (!userId) {
    bot.sendMessage(chatId, '❌ Не удалось определить ваш ID');
    return;
  }

  try {
    // Создаём или получаем пользователя
    const user = await getOrCreateUser(userId, from.username);

    // Обработка реферального кода
    if (param && param.startsWith('ref_')) {
      const referralCode = param.substring(4);
      
      // Проверяем, что пользователь не использует свой же промокод
      if (referralCode.toUpperCase() === user.promoCode) {
        bot.sendMessage(
          chatId,
          "⚠️ Сіз өз промокодыңызды пайдалана алмайсыз!\n\nДосыңыздан басқа код сұраңыз."
        );
        return;
      }

      // Находим пригласившего
      const inviter = await getUserByPromoCode(referralCode);
      
      if (inviter) {
        await incrementReferralCount(referralCode);
        
        bot.sendMessage(
          chatId,
          `🎉 Сізді досыңыз шақырды!\n\n` +
          `Промокод: ${referralCode}\n` +
          `Рамазан трекерге қош келдіңіз!`
        );
      } else {
        bot.sendMessage(
          chatId,
          "⚠️ Промокод табылмады.\n\nРамазан трекерге қош келдіңіз!"
        );
      }
    }

    // Показываем кнопку Mini App
    bot.sendMessage(
      chatId,
      `Ассаляму алейкум, ${from.first_name}! 🤲\n\n` +
      `Рамазан трекерді ашу үшін төмендегі батырманы басыңыз:`,
      {
        reply_markup: {
          keyboard: [
            [{
              text: "🌙 Рамазан трекерін ашу",
              web_app: { url: MINI_APP_URL }
            }]
          ],
          resize_keyboard: true
        }
      }
    );

  } catch (error) {
    console.error('❌ Ошибка в /start:', error);
    bot.sendMessage(chatId, '❌ Қате орын алды. Қайталап көріңіз.');
  }
});

// Команда /mycode - показать свой промокод
bot.onText(/\/mycode/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId) {
    bot.sendMessage(chatId, '❌ Не удалось определить ваш ID');
    return;
  }

  try {
    const user = await getUserById(userId);

    if (!user) {
      bot.sendMessage(chatId, '❌ Пользователь не найден. Используйте /start');
      return;
    }

    const botUsername = 'imantap_bot';
    const referralLink = 'https://t.me/' + botUsername + '?start=ref_' + user.promoCode;
    
    console.log('=== MYCODE DEBUG ===');
    console.log('Bot username:', botUsername);
    console.log('Promo code:', user.promoCode);
    console.log('Generated link:', referralLink);
    console.log('===================');

    const message = '🎁 Сіздің реферал коды:\n\n' +
      '📋 Код: ' + user.promoCode + '\n' +
      '👥 Шақырылғандар: ' + user.invitedCount + '\n\n' +
      '🔗 Реферал сілтеме:\n' + referralLink + '\n\n' +
      'Досыңызбен бөлісіңіз!';

    // БЕЗ parse_mode - подчёркивания будут видны!
    bot.sendMessage(chatId, message);

  } catch (error) {
    console.error('❌ Ошибка в /mycode:', error);
    bot.sendMessage(chatId, '❌ Қате орын алды. Қайталап көріңіз.');
  }
});

// Команда /stats - статистика
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId) {
    bot.sendMessage(chatId, '❌ Не удалось определить ваш ID');
    return;
  }

  try {
    const user = await getUserById(userId);

    if (!user) {
      bot.sendMessage(chatId, '❌ Пользователь не найден. Используйте /start');
      return;
    }

    bot.sendMessage(
      chatId,
      `📊 Ваша статистика:\n\n` +
      `👤 ID: ${user.userId}\n` +
      `📋 Промокод: ${user.promoCode}\n` +
      `👥 Приглашено: ${user.invitedCount}\n` +
      `📅 Регистрация: ${user.createdAt.toLocaleDateString('ru-RU')}`
    );

  } catch (error) {
    console.error('❌ Ошибка в /stats:', error);
    bot.sendMessage(chatId, '❌ Қате орын алды. Қайталап көріңіз.');
  }
});

// ===== HTTP API СЕРВЕР =====

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  
  // CORS заголовки - разрешаем запросы с фронтенда
  const allowedOrigins = [
    'https://imantap-production-6776.up.railway.app',
    'http://localhost:3000',
    'http://localhost:5173'
  ];
  
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  
  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  try {
    // GET /user/:userId - получить данные пользователя
    const userMatch = url.pathname.match(/^\/user\/(\d+)$/);
    if (req.method === 'GET' && userMatch) {
      const userId = userMatch[1];
      
      const user = await getOrCreateUser(userId);
      
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        data: {
          userId: user.userId,
          promoCode: user.promoCode,
          invitedCount: user.invitedCount,
          username: user.username
        }
      }));
      return;
    }

    // GET /referrals?code=XXXX - получить счётчик по промокоду
    if (req.method === 'GET' && url.pathname === '/referrals') {
      const code = url.searchParams.get('code');
      
      if (!code) {
        res.statusCode = 400;
        res.end(JSON.stringify({ 
          success: false, 
          error: 'Параметр code обязателен' 
        }));
        return;
      }

      const user = await getUserByPromoCode(code);
      
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        data: {
          code: code,
          invitedCount: user ? user.invitedCount : 0
        }
      }));
      return;
    }

    // GET /health - проверка здоровья сервера
    if (req.method === 'GET' && url.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 200;
      res.end(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        database: 'connected'
      }));
      return;
    }

    // 404 Not Found
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ 
      success: false, 
      error: 'Endpoint не найден' 
    }));

  } catch (error) {
    console.error('❌ Ошибка API:', error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ 
      success: false, 
      error: 'Внутренняя ошибка сервера' 
    }));
  }
});

server.listen(PORT, () => {
  console.log(`🚀 HTTP сервер запущен на порту ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});

console.log('🤖 Бот запущен и ожидает команд...');