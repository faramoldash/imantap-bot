import TelegramBot from 'node-telegram-bot-api';
import http from 'http';

const token = process.env.BOT_TOKEN;

if (!token) {
  throw new Error("BOT_TOKEN is not set");
}

const bot = new TelegramBot(token, { polling: true });
const MINI_APP_URL = "https://imantap-production-6776.up.railway.app";
const PORT = process.env.PORT || 3000;

// Хранилище: userId → {promoCode, invitedCount, username}
const users = {};

// Генерация промокода
function generatePromoCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const from = msg.from;
  const userId = from?.id;
  const param = match && match[1] ? match[1] : null;

  // Создаём пользователя если его нет
  if (userId && !users[userId]) {
    users[userId] = {
      promoCode: generatePromoCode(),
      invitedCount: 0,
      username: from.username || `user${userId}`
    };
    console.log(`✅ Новый пользователь: ${userId}, промокод: ${users[userId].promoCode}`);
  }

  // Если пришли с реферальным кодом: /start ref_XXXX
  if (param && param.startsWith('ref_')) {
    const referralCode = param.substring(4);
    
    // Найти владельца этого промокода
    const inviter = Object.values(users).find(u => u.promoCode === referralCode);
    
    if (inviter) {
      inviter.invitedCount += 1;
      console.log(`🎉 Реферал! Код=${referralCode}, новый счёт=${inviter.invitedCount}, приглашённый=${userId}`);
    }

    bot.sendMessage(
      chatId,
      "Сізді досыңыз шақырды 🌙\n\nРамазан трекерге қош келдіңіз!"
    );
  }

  // Обычный старт: показываем кнопку Mini App
  bot.sendMessage(
    chatId,
    "Ассаляму алейкум 🤲\n\nРамазан трекерді ашу үшін төмендегі батырманы басыңыз:",
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
});

// HTTP сервер для API
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  // GET /user/:userId - получить данные пользователя
  const userMatch = url.pathname.match(/^\/user\/(\d+)$/);
  if (req.method === 'GET' && userMatch) {
    const userId = userMatch[1];
    
    // Создаём пользователя если его нет
    if (!users[userId]) {
      users[userId] = {
        promoCode: generatePromoCode(),
        invitedCount: 0,
        username: `user${userId}`
      };
      console.log(`✅ Создан пользователь через API: ${userId}, код: ${users[userId].promoCode}`);
    }
    
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      userId: userId,
      promoCode: users[userId].promoCode,
      invitedCount: users[userId].invitedCount
    }));
    return;
  }

  // Старый endpoint для обратной совместимости
  // GET /referrals?code=XXXX
  if (req.method === 'GET' && url.pathname === '/referrals') {
    const code = url.searchParams.get('code');
    const user = Object.values(users).find(u => u.promoCode === code);
    const count = user ? user.invitedCount : 0;
    
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ code, invitedCount: count }));
    return;
  }

  // 404
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`🚀 HTTP server listening on port ${PORT}`);
});

console.log("🤖 Bot is running...");