import TelegramBot from 'node-telegram-bot-api';

const token = process.env.BOT_TOKEN;
if (!token) {
  throw new Error("BOT_TOKEN is not set");
}

const bot = new TelegramBot(token, { polling: true });

const MINI_APP_URL = "https://imantap-production-6776.up.railway.app";

// Простое хранилище рефералов в памяти
const referralStats = {};

import http from 'http';

const PORT = process.env.PORT || 3000;

bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const from = msg.from;
  const param = match && match[1] ? match[1] : null; // то, что после /start

  // Если пришли с реферальным кодом: /start ref_XXXX
  if (param && param.startsWith('ref_')) {
    const referralCode = param.substring(4); // без "ref_"

    // УВЕЛИЧИВАЕМ СЧЁТЧИК ПРИГЛАШЕНИЙ ДЛЯ ЭТОГО КОДА
    if (!referralStats[referralCode]) {
      referralStats[referralCode] = { invitedCount: 0 };
    }
    referralStats[referralCode].invitedCount += 1;

    console.log(
      `Новый реферал: код=${referralCode}, invitedCount=${referralStats[referralCode].invitedCount}, user_id=${from?.id}`
    );

    // Можно отправить приглашённому короткое приветствие
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
          [
            {
              text: "🌙 Рамазан трекерін ашу",
              web_app: { url: MINI_APP_URL }
            }
          ]
        ],
        resize_keyboard: true
      }
    }
  );
});

// Простой HTTP‑сервер для выдачи статистики по рефералам
const server = http.createServer((req, res) => {
  // Разбираем URL
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // GET /referrals?code=XXXX
  if (req.method === 'GET' && url.pathname === '/referrals') {
    const code = url.searchParams.get('code');

    const count =
      code && referralStats[code] && referralStats[code].invitedCount
        ? referralStats[code].invitedCount
        : 0;

    // CORS, чтобы Mini App потом мог обращаться
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ code, invitedCount: count }));
    return;
  }

  // Всё остальное — 404
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not found');
});

// Запускаем HTTP‑сервер
server.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

console.log("🤖 Bot is running...");