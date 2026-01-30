import TelegramBot from 'node-telegram-bot-api';

const token = process.env.BOT_TOKEN;
if (!token) {
  throw new Error("BOT_TOKEN is not set");
}

const bot = new TelegramBot(token, { polling: true });

const MINI_APP_URL = "https://imantap-production-6776.up.railway.app";

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

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

console.log("🤖 Bot is running...");
