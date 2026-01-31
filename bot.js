// bot.js
import TelegramBot from 'node-telegram-bot-api';
import http from 'http';
import dotenv from 'dotenv';
import { connectDB, getDB, createIndexes } from './db.js';
import {
  getOrCreateUser,
  getUserById,
  getUserByPromoCode,
  incrementReferralCount,
  updateUserProgress,
  getUserFullData,
  // Новые функции
  updateUserOnboarding,
  checkPromoCode,
  markPromoCodeAsUsed,
  updatePaymentStatus,
  approvePayment,
  rejectPayment,
  getUserAccess
} from './userService.js';
import {
  getSession,
  setState,
  getState,
  setSessionData,
  getSessionData,
  clearSession
} from './sessionManager.js';
import schedule from 'node-schedule';


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

// Создаём индексы (выполнится один раз)
await createIndexes();

// =====================================================
// 🌙 РАМАЗАН УВЕДОМЛЕНИЯ - Сухур и Ифтар
// =====================================================

const RAMADAN_TIMES = {
  suhur: {
    hour: 1,
    minute: 11, // За 10 минут до Фаджр (05:25)
    name_kk: 'Ауыз бекітетін уақыт',
    emoji: '🌙',
    message: `🌙 *Ауыз бекітетін уақыт болды*

Сәресіде айтылатын дұға:

نَوَيْتُ أنْ أصُومَ صَوْمَ شَهْرُ رَمَضَانَ مِنَ الْفَجْرِ إِلَى الْمَغْرِبِ خَالِصًا لِلَّهِ تَعَالَى

*Оқылуы:* «Нәуәйту ән асумә саумә шәһри Рамаданә минәл фәжри иләл мағриби халисан лилләһи таъалә».

*Мағынасы:* «Таңертеннен кешке дейін Алланың ризалығы үшін Рамазан айының оразасын ұстауға ниет еттім».

Алла Тағала оразаңызды қабыл етсін! 🤲`
  },
  iftar: {
    hour: 18,
    minute: 45, // Магриб намаз уақыты
    name_kk: 'Ауызашар уақыты',
    emoji: '🍽️',
    message: `🍽️ *Ауызашар уақыты жақындап қалды*

Ауызашарда оқылатын дұға:

اللَّهُمَّ لَكَ صُمْتُ وَ بِكَ آمَنْتُ وَ عَلَيْكَ تَوَكَّلْتُ وَ على رِزْقِكَ اَفْطَرْتُ وَ صَوْمَ الْغَدِ مِنْ شَهْرِرَمَضانَ نَوَيْتُ فاغْفِرْ لِي ما قَدَّمْتُ وَ ما اَخَّرْتُ

*Оқылуы:* «Аллаһуммә ләкә сумту уә бикә әәмәнту уә 'аләйкә тәуәккәлту уә 'ала ризқикә әфтарту уә саумәлғади мин шәһри Рамадана нәуәйту, фәғфирлии мәә қаддамту уә мәә аххарту».

*Мағынасы:* «Алла Тағалам! Сенің ризалығың үшін ораза ұстадым. Сенің берген ризығыңмен аузымды аштым. Саған иман етіп, саған тәуекел жасадым. Рамазан айының ертеңгі күніне де ауыз бекітуге ниет еттім. Сен менің өткен және келешек күнәларымды кешір».

Ас-сәлем! 🤲`
  }
};

// Функция отправки Рамазан уведомлений
async function sendRamadanReminder(reminderType, reminderData) {
  try {
    const db = getDB();
    const users = db.collection('users');
    
    // Получаем активных пользователей (заходили за последние 3 дня)
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const activeUsers = await users.find({
      createdAt: { $gte: threeDaysAgo }
    }).toArray();
    
    console.log(`${reminderData.emoji} Отправка уведомлений: ${reminderData.name_kk}. Пользователей: ${activeUsers.length}`);
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const user of activeUsers) {
      try {
        await bot.sendMessage(
          user.userId, 
          reminderData.message,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { 
                  text: '✅ Жасалды', 
                  callback_data: `ramadan_${reminderType}_done` 
                }
              ]]
            }
          }
        );
        
        successCount++;
        
        // Задержка 100ms между отправками
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        errorCount++;
        console.error(`Ошибка отправки ${user.userId}:`, error.message);
      }
    }
    
    console.log(`✅ Отправлено. Успешно: ${successCount}, Ошибок: ${errorCount}`);
  } catch (error) {
    console.error('❌ Ошибка отправки уведомлений:', error);
  }
}

// Планируем уведомления
console.log('⏰ Настройка расписания Рамазан уведомлений...');

Object.entries(RAMADAN_TIMES).forEach(([reminderType, reminderData]) => {
  // Cron формат: минута час * * * (каждый день)
  const cronExpression = `${reminderData.minute} ${reminderData.hour} * * *`;
  
  schedule.scheduleJob(cronExpression, () => {
    console.log(`⏰ Время отправки: ${reminderData.name_kk}`);
    sendRamadanReminder(reminderType, reminderData);
  });
  
  console.log(`   ✓ ${reminderData.emoji} ${reminderData.name_kk}: ${String(reminderData.hour).padStart(2, '0')}:${String(reminderData.minute).padStart(2, '0')}`);
});

console.log('✅ Расписание Рамазан уведомлений настроено!\n');

// =====================================================
// 🎯 ОБРАБОТКА CALLBACK КНОПОК
// =====================================================

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  
  console.log(`📲 Callback: ${data} от ${query.from.id}`);
  
  // Обработка кнопки "Жасалды"
  if (data.startsWith('ramadan_')) {
    const [_, type, action] = data.split('_');
    
    if (action === 'done') {
      try {
        await bot.answerCallbackQuery(query.id, {
          text: 'МашаАллаһ! ✅',
          show_alert: false
        });
        
        await bot.editMessageText(
          query.message.text + '\n\n✅ *Жасалды!*', 
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown'
          }
        );
        
        console.log(`✅ Пользователь ${query.from.id} подтвердил: ${type}`);
      } catch (error) {
        console.error('❌ Ошибка обработки callback:', error);
      }
    }
  }
});

// =====================================================
// 🎯 ОНБОРДИНГ ФЛОУ
// =====================================================

async function startOnboarding(chatId, userId, firstName) {
  await bot.sendMessage(
    chatId,
    `🌙 *Ассаляму алейкум, ${firstName}!*\n\n` +
    `Добро пожаловать в *Imantap* - ваш личный помощник на Рамазан.\n\n` +
    `Настроим всё за 2 минуты! 🚀`,
    { parse_mode: 'Markdown' }
  );

  // Небольшая задержка для читабельности
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Шаг 1: Запрос телефона
  await bot.sendMessage(
    chatId,
    `📱 *Шаг 1/3: Номер телефона*\n\n` +
    `Для персональных уведомлений и восстановления доступа.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [[{
          text: '📱 Поделиться номером',
          request_contact: true
        }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    }
  );

  setState(userId, 'WAITING_PHONE');
}

async function requestLocation(chatId, userId) {
  await bot.sendMessage(
    chatId,
    `✅ Отлично!\n\n` +
    `📍 *Шаг 2/3: Ваш город*\n\n` +
    `Для точного времени намазов.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          [{ text: '📍 Поделиться геолокацией', request_location: true }],
          [{ text: '🌍 Astana' }, { text: '🌍 Almaty' }],
          [{ text: '🌍 Shymkent' }, { text: '🌍 Другой город' }]
        ],
        resize_keyboard: true
      }
    }
  );

  setState(userId, 'WAITING_LOCATION');
}

async function requestPromoCode(chatId, userId) {
  const session = getSession(userId);
  
  // Проверяем есть ли реферал
  if (session.data.referralCode) {
    // Есть реферал - пропускаем промокод, сразу к оплате
    await showPayment(chatId, userId, 1990, true);
    return;
  }

  // Нет реферала - спрашиваем промокод
  await bot.sendMessage(
    chatId,
    `🎟️ *Шаг 3/3: Промокод*\n\n` +
    `Есть промокод? Получите скидку -500₸!\n\n` +
    `Введите промокод или нажмите "Пропустить"`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [['⏭️ Пропустить']],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    }
  );

  setState(userId, 'WAITING_PROMO');
}

async function showPayment(chatId, userId, price, hasDiscount) {
  const kaspiLink = process.env.KASPI_LINK || 'https://kaspi.kz/pay/imantap';

  const discountText = hasDiscount 
    ? `~~2490₸~~ → *${price}₸* 🎁\n` 
    : `*${price}₸*\n`;

  await bot.sendMessage(
    chatId,
    `💳 *Оплата доступа*\n\n` +
    `Imantap Premium - ${discountText}\n` +
    `✓ Персональные времена намазов\n` +
    `✓ Трекинг 30 дней Рамазана\n` +
    `✓ 99 имён Аллаха\n` +
    `✓ Чтение Корана по джузам\n` +
    `✓ Система наград и XP\n` +
    `✓ Лидерборд\n\n` +
    `После оплаты отправьте чек сюда.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 Оплатить через Kaspi', url: kaspiLink }],
          [{ text: '📄 У меня есть чек', callback_data: 'have_receipt' }]
        ],
        remove_keyboard: true
      }
    }
  );

  // Сохраняем данные оплаты
  await updateUserOnboarding(userId, {
    paidAmount: price,
    hasDiscount: hasDiscount,
    paymentStatus: 'unpaid'
  });

  setState(userId, 'WAITING_RECEIPT');
}

// =====================================================
// 📞 ОБРАБОТЧИКИ КОНТАКТОВ И ГЕОЛОКАЦИИ
// =====================================================

bot.on('contact', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const state = getState(userId);

  if (state === 'WAITING_PHONE') {
    const phone = msg.contact.phone_number;

    await updateUserOnboarding(userId, { phoneNumber: phone });

    await requestLocation(chatId, userId);
  }
});

bot.on('location', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const state = getState(userId);

  if (state === 'WAITING_LOCATION') {
    const { latitude, longitude } = msg.location;

    // Простое определение города (можно улучшить с API)
    let city = 'Astana';
    
    await updateUserOnboarding(userId, {
      location: {
        city,
        country: 'Kazakhstan',
        latitude,
        longitude
      }
    });

    await requestPromoCode(chatId, userId);
  }
});

// Обработка текстовых сообщений
bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text = msg.text;
  const state = getState(userId);

  // Игнорируем команды и спец. сообщения
  if (!text || text.startsWith('/') || msg.contact || msg.location) {
    return;
  }

  // Выбор города вручную
  if (state === 'WAITING_LOCATION') {
    let city = text.replace('🌍 ', '').trim();

    if (city === 'Другой город') {
      await bot.sendMessage(
        chatId,
        'Введите название вашего города:',
        { reply_markup: { remove_keyboard: true } }
      );
      setState(userId, 'WAITING_CITY_NAME');
      return;
    }

    await updateUserOnboarding(userId, {
      location: {
        city,
        country: 'Kazakhstan',
        latitude: null,
        longitude: null
      }
    });

    await requestPromoCode(chatId, userId);
    return;
  }

  // Ввод названия города
  if (state === 'WAITING_CITY_NAME') {
    const city = text.trim();

    await updateUserOnboarding(userId, {
      location: {
        city,
        country: 'Kazakhstan',
        latitude: null,
        longitude: null
      }
    });

    await requestPromoCode(chatId, userId);
    return;
  }

  // Обработка промокода
  if (state === 'WAITING_PROMO') {
    if (text === '⏭️ Пропустить') {
      await showPayment(chatId, userId, 2490, false);
      return;
    }

    const promoCode = text.toUpperCase().trim();

    // Проверяем промокод
    const check = await checkPromoCode(promoCode, userId);

    if (check.valid) {
      await updateUserOnboarding(userId, {
        usedPromoCode: promoCode,
        hasDiscount: true
      });

      await markPromoCodeAsUsed(promoCode, userId);

      await bot.sendMessage(
        chatId,
        `✅ *Промокод принят!*\n\n` +
        `Ваша цена: ~~2490₸~~ → *1990₸*`,
        { parse_mode: 'Markdown' }
      );

      await showPayment(chatId, userId, 1990, true);
    } else {
      let errorMsg = '❌ *Промокод недействителен*\n\n';

      if (check.reason === 'not_found') {
        errorMsg += 'Такой промокод не существует.';
      } else if (check.reason === 'already_used') {
        errorMsg += 'Этот промокод уже использован.';
      } else if (check.reason === 'own_code') {
        errorMsg += 'Нельзя использовать свой промокод.';
      } else if (check.reason === 'owner_not_paid') {
        errorMsg += 'Владелец промокода ещё не оплатил доступ.';
      }

      errorMsg += '\n\nПопробуйте другой или пропустите.';

      await bot.sendMessage(chatId, errorMsg, { parse_mode: 'Markdown' });
    }
    return;
  }
});

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
    // Получаем или создаём пользователя
    let user = await getUserById(userId);
    
    if (!user) {
      user = await getOrCreateUser(userId, from.username);
    }

    // Проверяем завершён ли онбординг
    if (user.onboardingCompleted && user.paymentStatus === 'paid') {
      // Пользователь уже прошёл онбординг и оплатил
      bot.sendMessage(
        chatId,
        `Ассаляму алейкум, ${from.first_name}! 🤲\n\n` +
        `Добро пожаловать обратно!\n\n` +
        `Откройте трекер:`,
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
      return;
    }

    // Обрабатываем реферальный код
    let referralCode = null;
    if (param && param.startsWith('ref_')) {
      referralCode = param.substring(4);
      
      // Проверяем что это не свой промокод
      if (referralCode.toUpperCase() === user.promoCode) {
        bot.sendMessage(
          chatId,
          "⚠️ Вы не можете использовать свой промокод!"
        );
        return;
      }

      // Проверяем существует ли такой промокод
      const inviter = await getUserByPromoCode(referralCode);
      
      if (inviter) {
        // Сохраняем реферал в сессию
        setSessionData(userId, 'referralCode', referralCode);
        
        bot.sendMessage(
          chatId,
          `🎁 *У вас есть реферальная ссылка!*\n\n` +
          `Ваш друг пригласил вас.\n` +
          `Вы получите скидку -500₸!\n\n` +
          `Давайте начнём настройку! 🚀`,
          { parse_mode: 'Markdown' }
        );
      }
    }

    // Начинаем онбординг
    await startOnboarding(chatId, userId, from.first_name);

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
    'https://web.telegram.org',
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
    // GET /api/user/:userId - получить данные пользователя
    const userMatch = url.pathname.match(/^\/api\/user\/(\d+)$/);
    if (req.method === 'GET' && userMatch) {
      const userId = parseInt(userMatch[1]);
      
      const user = await getUserById(userId);
      
      if (!user) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = 404;
        res.end(JSON.stringify({
          success: false,
          error: 'User not found'
        }));
        return;
      }
      
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

    // GET /api/user/:userId/full - получить ВСЕ данные пользователя
    const userFullMatch = url.pathname.match(/^\/api\/user\/(\d+)\/full$/);
    if (req.method === 'GET' && userFullMatch) {
      const userId = parseInt(userFullMatch[1]);
      
      const userData = await getUserFullData(userId);
      
      if (!userData) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = 404;
        res.end(JSON.stringify({
          success: false,
          error: 'User not found'
        }));
        return;
      }
      
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        data: userData
      }));
      return;
    }

    // GET /api/user/:userId/access - проверить доступ
    const accessMatch = url.pathname.match(/^\/api\/user\/(\d+)\/access$/);
    if (req.method === 'GET' && accessMatch) {
      const userId = parseInt(accessMatch[1]);
      
      const access = await getUserAccess(userId);
      
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        data: access
      }));
      return;
    }

    // POST /api/user/:userId/sync - синхронизировать прогресс
    const syncMatch = url.pathname.match(/^\/api\/user\/(\d+)\/sync$/);
    if (req.method === 'POST' && syncMatch) {
      const userId = parseInt(syncMatch[1]);
      
      // Читаем тело запроса
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      
      req.on('end', async () => {
        try {
          const progressData = JSON.parse(body);
          
          const success = await updateUserProgress(userId, progressData);
          
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.statusCode = 200;
          res.end(JSON.stringify({
            success: success,
            message: success ? 'Progress synced' : 'No changes made'
          }));
        } catch (error) {
          console.error('❌ Ошибка синхронизации:', error);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ 
            success: false, 
            error: 'Sync failed' 
          }));
        }
      });
      
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