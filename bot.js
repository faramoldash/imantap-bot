// bot.js
import TelegramBot from 'node-telegram-bot-api';
import http from 'http';
import dotenv from 'dotenv';
import { connectDB, getDB, createIndexes } from './db.js';
import { getPrayerTimesByCity, calculateReminderTime, updateUserPrayerTimes } from './prayerTimesService.js';
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
  getUserAccess,
  getPendingPayments
} from './userService.js';
import {
  isAdmin,
  addManager,
  removeManager,
  listManagers,
  getAdmins
} from './adminService.js';
import {
  getSession,
  setState,
  getState,
  setSessionData,
  getSessionData,
  clearSession
} from './sessionManager.js';
import schedule from 'node-schedule';

// ✅ Простая защита от DDOS
const requestCounts = new Map();
const RATE_LIMIT = 100; // максимум запросов
const RATE_WINDOW = 60000; // за 1 минуту

function checkRateLimit(userId) {
  const now = Date.now();
  const userRequests = requestCounts.get(userId) || [];
  
  // Удаляем старые запросы
  const recentRequests = userRequests.filter(time => now - time < RATE_WINDOW);
  
  if (recentRequests.length >= RATE_LIMIT) {
    return false; // Превышен лимит
  }
  
  recentRequests.push(now);
  requestCounts.set(userId, recentRequests);
  return true;
}

// Очистка старых данных каждые 5 минут
setInterval(() => {
  const now = Date.now();
  for (const [userId, requests] of requestCounts.entries()) {
    const recentRequests = requests.filter(time => now - time < RATE_WINDOW);
    if (recentRequests.length === 0) {
      requestCounts.delete(userId);
    } else {
      requestCounts.set(userId, recentRequests);
    }
  }
}, 5 * 60000);

dotenv.config();

// Валидация переменных окружения
if (!process.env.BOT_TOKEN) {
  throw new Error('❌ BOT_TOKEN не указан в .env файле');
}

const token = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL || "https://imantap-production-6776.up.railway.app";
const PORT = process.env.PORT || 8080;

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
// 🌙 ПЕРСОНАЛИЗИРОВАННЫЕ РАМАЗАН УВЕДОМЛЕНИЯ
// =====================================================

const RAMADAN_MESSAGES = {
  suhur: {
    kk: `🌙 *Ауыз бекітетін уақыт жақындап қалды*

Сәресіде айтылатын дұға:

نَوَيْتُ أنْ أصُومَ صَوْمَ شَهْرُ رَمَضَانَ مِنَ الْفَجْرِ إِلَى الْمَغْرِبِ خَالِصًا لِلَّهِ تَعَالَى

*Оқылуы:* «Нәуәйту ән асумә саумә шәһри Рамаданә минәл фәжри иләл мағриби халисан лилләһи таъалә»

*Мағынасы:* «Таңертеннен кешке дейін Алланың ризалығы үшін Рамазан айының оразасын ұстауға ниет еттім»

Алла Тағала оразаңызды қабыл етсін! 🤲

📿 Таң намазы: {PRAYER_TIME}`,
    ru: `🌙 *Время сухура приближается*

Дуа при сухуре:

نَوَيْتُ أنْ أصُومَ صَوْمَ شَهْرُ رَمَضَانَ مِنَ الْفَجْرِ إِلَى الْمَغْرِبِ خَالِصًا لِلَّهِ تَعَالَى

*Транскрипция:* «Науэйту ан асума саума шахри Рамадана миналь-фаджри иляль-магриби халисан лиллахи таъаля»

*Перевод:* «Я намереваюсь держать пост месяца Рамадан от рассвета до заката ради Аллаха»

Пусть Аллах примет вашу оразу! 🤲

📿 Намаз Фаджр: {PRAYER_TIME}`
  },
  iftar: {
    kk: `🌆 *Ауыз ашатын уақыт жақындап қалды*

Ауыз ашқанда айтылатын дұға:

اللَّهُمَّ لَكَ صُمْتُ وَ بِكَ آمَنْتُ وَ عَلَيْكَ تَوَكَّلْتُ وَ عَلَى رِزْقِكَ أَفْطَرْتُ

*Оқылуы:* «Аллаһумма ләкә сумту уә бикә әәмәнту уә 'аләйкә тәуәккәлту уә 'ала ризқикә әфтарту»

*Мағынасы:* «Алла Тағалам! Сенің ризалығың үшін ораза ұстадым. Саған иман етіп, саған тәуекел жасадым. Сенің берген ризығыңмен аузымды аштым»

Оразаңыз қабыл болсын! 🤲
Асыққан-ұмтылғандарға берекет берсін! 🍽️

📿 Ақшам намазы: {PRAYER_TIME}`,
    ru: `🌆 *Время ифтара приближается*

Дуа при разговении:

اللَّهُمَّ لَكَ صُمْتُ وَ بِكَ آمَنْتُ وَ عَلَيْكَ تَوَكَّلْتُ وَ عَلَى رِزْقِكَ أَفْطَرْتُ

*Транскрипция:* «Аллахумма ляка сумту уа бика ааманту уа 'аляйка тауаккяльту уа 'аля ризкыка афтарту»

*Перевод:* «О Аллах! Я постился ради Тебя, уверовал в Тебя, положился на Тебя и разговелся тем, что Ты даровал»

Пусть Аллах примет вашу оразу! 🤲
Приятного ифтара! 🍽️

📿 Намаз Магриб: {PRAYER_TIME}`
  }
};

// Функция отправки персонализированных уведомлений
async function sendPersonalizedRamadanReminder(type) {
  try {
    const db = getDB();
    const users = db.collection('users');
    
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    
    // Находим пользователей с временами намазов
    const activeUsers = await users.find({
      'prayerTimes.fajr': { $exists: true },
      paymentStatus: { $in: ['paid', 'demo'] }
    }).toArray();
    
    if (activeUsers.length === 0) return;
    
    let sentCount = 0;
    
    for (const user of activeUsers) {
      try {
        const prayerTimes = user.prayerTimes;
        const minutesBefore = 30; // За 30 минут
        const lang = user.language || 'kk';
        
        let shouldSend = false;
        let prayerTime = '';
        
        // Проверяем сухур (Fajr)
        if (type === 'suhur' && prayerTimes.fajr) {
          const reminderTime = calculateReminderTime(prayerTimes.fajr, minutesBefore);
          if (reminderTime.hour === currentHour && reminderTime.minute === currentMinute) {
            shouldSend = true;
            prayerTime = prayerTimes.fajr;
          }
        }
        
        // Проверяем ифтар (Maghrib)
        if (type === 'iftar' && prayerTimes.maghrib) {
          const reminderTime = calculateReminderTime(prayerTimes.maghrib, minutesBefore);
          if (reminderTime.hour === currentHour && reminderTime.minute === currentMinute) {
            shouldSend = true;
            prayerTime = prayerTimes.maghrib;
          }
        }
        
        if (shouldSend) {
          const message = RAMADAN_MESSAGES[type][lang].replace('{PRAYER_TIME}', prayerTime);
          
          await bot.sendMessage(user.userId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { 
                  text: lang === 'kk' ? '✅ Жасалды' : '✅ Готово', 
                  callback_data: `ramadan_${type}_done` 
                }
              ]]
            }
          });
          
          sentCount++;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error(`❌ Ошибка отправки ${user.userId}:`, error.message);
      }
    }
    
    if (sentCount > 0) {
      console.log(`✅ ${type === 'suhur' ? '🌙 Сухур' : '🌆 Ифтар'} уведомления: ${sentCount} пользователей`);
    }
  } catch (error) {
    console.error('❌ Ошибка уведомлений:', error);
  }
}

// ✅ Проверка каждую минуту
console.log('⏰ Система персонализированных уведомлений запущена');

setInterval(async () => {
  await sendPersonalizedRamadanReminder('suhur');
  await sendPersonalizedRamadanReminder('iftar');
}, 60 * 1000);

// ✅ Обновляем времена намазов каждую ночь в 00:00
schedule.scheduleJob('0 0 * * *', async () => {
  console.log('🔄 Обновление времен намазов...');
  
  const db = getDB();
  const users = db.collection('users');
  const allUsers = await users.find({ 
    'location.city': { $exists: true }
  }).toArray();
  
  let updated = 0;
  for (const user of allUsers) {
    const success = await updateUserPrayerTimes(user.userId);
    if (success) updated++;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log(`✅ Обновлено: ${updated}/${allUsers.length} пользователей`);
});

// 📊 Напоминание отметить прогресс (каждый день в 20:00)
schedule.scheduleJob('0 20 * * *', async () => {
  console.log('📊 Проверка прогресса пользователей...');
  
  const db = getDB();
  const users = db.collection('users');
  
  const today = new Date().toISOString().split('T')[0];
  
  // Пользователи которые не отмечали прогресс сегодня
  const inactiveUsers = await users.find({
    paymentStatus: { $in: ['paid', 'demo'] },
    'notificationSettings.ramadanReminders': { $ne: false },
    $or: [
      { lastActiveDate: { $ne: today } },
      { lastActiveDate: { $exists: false } }
    ]
  }).toArray();
  
  let sentCount = 0;
  
  for (const user of inactiveUsers) {
    try {
      const message = user.language === 'kk'
        ? `📲 *Бүгін әлі ештеңе белгіленбеді!*

Прогрессіңізді белгілеуді ұмытпаңыз! 🌙

Әр белгі — бұл сіздің руханилығыңызға қадам! 💪

Қазір белгілеңіз! 👇`
        : `📲 *Сегодня еще ничего не отмечено!*

Не забудьте отметить свой прогресс! 🌙

Каждая отметка — это шаг к духовности! 💪

Отметьте сейчас! 👇`;
      
      await bot.sendMessage(user.userId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [[{
            text: '📱 ImanTap ашу',
            web_app: { url: `${MINI_APP_URL}?tgWebAppStartParam=${user.userId}` }
          }]],
          resize_keyboard: true
        }
      });
      
      sentCount++;
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`❌ Напоминание ${user.userId}:`, error.message);
    }
  }
  
  if (sentCount > 0) {
    console.log(`✅ Напоминания о прогрессе: ${sentCount} пользователей`);
  }
});

console.log('✅ Напоминание о прогрессе настроено (20:00)\n');

console.log('✅ Автообновление времен настроено (00:00)\n');

// =====================================================
// 🎯 ОБРАБОТКА ВСЕХ CALLBACK КНОПОК
// =====================================================

bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const data = query.data;
  const messageId = query.message.message_id;
  const chatId = query.message.chat.id;
  
  console.log(`📲 Callback: ${data} от ${userId}`);

  // ==========================================
  // Обработка кнопок Рамазан уведомлений
  // ==========================================
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
        
        console.log(`✅ Пользователь ${userId} подтвердил: ${type}`);
      } catch (error) {
        console.error('❌ Ошибка обработки callback:', error);
      }
    }
    return; // Важно! Выходим после обработки
  }

  // ⚙️ НАСТРОЙКИ - Смена города
  if (data === 'change_city') {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, '📍 Жаңа қаланы жазыңыз:\n\nМысалы: Астана, Алматы, Шымкент, Ташкент', {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          ['Астана', 'Алматы'],
          ['Шымкент', 'Ақтөбе'],
          ['Қарағанды', 'Тараз'],
          ['Атырау', 'Ақтау'],
          ['❌ Болдырмау']
        ],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
    setState(userId, 'CHANGING_CITY');
    return;
  }

  // 🔔 НАСТРОЙКИ - Вкл/Откл уведомлений
  if (data === 'toggle_notifications') {
    try {
      const user = await getUserById(userId);
      const newValue = !(user.notificationSettings?.ramadanReminders !== false);
      
      await updateUserOnboarding(userId, {
        notificationSettings: {
          ramadanReminders: newValue,
          reminderMinutesBefore: 30
        }
      });
      
      await bot.answerCallbackQuery(query.id, {
        text: newValue ? '✅ Хабарландырулар қосылды' : '🔕 Хабарландырулар өшірілді',
        show_alert: true
      });
      
      // Обновляем сообщение
      const prayerTimesInfo = user.prayerTimes 
        ? `✅ *Намаз уақыттары:*\n🌅 Таң: ${user.prayerTimes.fajr}\n🌆 Ақшам: ${user.prayerTimes.maghrib}`
        : '⚠️ Намаз уақыттары белгіленбеген';
      
      const updatedMessage = `⚙️ *Сіздің баптауларыңыз:*\n\n📍 *Қала:* ${user.location?.city || 'Белгісіз'}\n\n${prayerTimesInfo}\n\n🔔 *Хабарландырулар:* ${newValue ? '✅ Қосулы' : '❌ Өшірулі'}`;
      
      await bot.editMessageText(updatedMessage, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📍 Қаланы өзгерту', callback_data: 'change_city' }],
            [{ text: newValue ? '🔕 Хабарландыруды өшіру' : '🔔 Хабарландыруды қосу', callback_data: 'toggle_notifications' }],
            [{ text: '🔄 Уақытты жаңарту', callback_data: 'update_prayer_times' }]
          ]
        }
      });
    } catch (error) {
      console.error('toggle_notifications ошибка:', error);
      await bot.answerCallbackQuery(query.id, { text: '❌ Қате', show_alert: true });
    }
    return;
  }

  // 🔄 НАСТРОЙКИ - Обновить времена намазов
  if (data === 'update_prayer_times') {
    try {
      const success = await updateUserPrayerTimes(userId);
      
      if (success) {
        const user = await getUserById(userId);
        await bot.answerCallbackQuery(query.id, {
          text: `✅ Жаңартылды!\n🌅 ${user.prayerTimes.fajr}\n🌆 ${user.prayerTimes.maghrib}`,
          show_alert: true
        });
      } else {
        await bot.answerCallbackQuery(query.id, {
          text: '⚠️ Қала мәліметі жоқ',
          show_alert: true
        });
      }
    } catch (error) {
      console.error('update_prayer_times ошибка:', error);
      await bot.answerCallbackQuery(query.id, { text: '❌ Қате', show_alert: true });
    }
    return;
  }

  // ==========================================
  // Обработка кнопки "У меня есть чек"
  // ==========================================
  if (data === 'have_receipt') {
    await bot.answerCallbackQuery(query.id);
    
    await bot.sendMessage(
      chatId,
      `📸 *Төлем чегін жіберіңіз*\n\n` +
      `Бұл мыналар болуы мүмкін:\n` +
      `• Kaspi-ден скриншот\n` +
      `• Квитанция фотосы\n` +
      `• PDF құжат\n` +
      `• Аударым растамасы\n\n` +
      `Файлды осында жіберіңіз 👇`,
      { parse_mode: 'Markdown' }
    );

    setState(userId, 'WAITING_RECEIPT');
    return;
  }

  // ==========================================
  // Проверка прав для админских действий
  // ==========================================
  const hasAccess = await isAdmin(userId);
  if (!hasAccess && (data.startsWith('approve_') || data.startsWith('reject_'))) {
    await bot.answerCallbackQuery(query.id, { text: '❌ Доступ запрещён' });
    return;
  }

  // ==========================================
  // Подтверждение оплаты
  // ==========================================
  if (data.startsWith('approve_')) {
    const targetUserId = parseInt(data.replace('approve_', ''));

    try {
      await approvePayment(targetUserId);

      // Обновляем сообщение админа (БЕЗ MARKDOWN!)
      const originalCaption = query.message.caption || '';
      const baseInfo = originalCaption.split('Подтвердить оплату?')[0];
      
      await bot.editMessageCaption(
        `✅ ОПЛАТА ПОДТВЕРЖДЕНА\n\n` +
        baseInfo +
        `\n✅ Подтвердил: ${query.from.username ? '@' + query.from.username : 'ID: ' + userId}\n` +
        `⏰ ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}`,
        {
          chat_id: chatId,
          message_id: messageId
          // БЕЗ parse_mode!
        }
      );

      await bot.answerCallbackQuery(query.id, { text: '✅ Оплата подтверждена!' });

      // Уведомляем пользователя (НА КАЗАХСКОМ!)
      await bot.sendMessage(
        targetUserId,
        `🎉 Төлем расталды!\n\n` +
        `ImanTap Premium-ға қош келдіңіз! 🌙\n\n` +
        `Трекерді ашу үшін төмендегі батырманы басыңыз:`,
        {
          reply_markup: {
            keyboard: [
              [{ 
                text: '📱 ImanTap ашу', 
                web_app: { url: `${MINI_APP_URL}?tgWebAppStartParam=${targetUserId}` }
              }],
              ['⚙️ Баптаулар', '📊 Статистика'],
              ['🎁 Менің промокодым']
            ],
            resize_keyboard: true
          }
        }
      );

      // Начисляем реферальный бонус (если есть)
      const user = await getUserById(targetUserId);
      if (user.referredBy) {
        const inviter = await getUserByPromoCode(user.referredBy);
        if (inviter) {
          await incrementReferralCount(inviter.userId);
          console.log(`🎉 Реферал засчитан для промокода: ${user.referredBy}`);
          
          await bot.sendMessage(
            inviter.userId,
            `🎁 Жаңа реферал!\n\n` +
            `Сіздің досыңыз төлем жасады.\n` +
            `Барлық рефералдар: ${inviter.invitedCount + 1} 🔥`
          );
        }
      }

      console.log(`✅ Оплата подтверждена для пользователя ${targetUserId}`);

    } catch (error) {
      console.error('❌ Ошибка подтверждения:', error);
      await bot.answerCallbackQuery(query.id, { 
        text: '❌ Ошибка при подтверждении', 
        show_alert: true 
      });
    }
    return;
  }

  // ==========================================
  // Отклонение оплаты
  // ==========================================
  if (data.startsWith('reject_')) {
    const targetUserId = parseInt(data.replace('reject_', ''));

    try {
      await rejectPayment(targetUserId);

      // Обновляем сообщение админа (БЕЗ MARKDOWN!)
      const originalCaption = query.message.caption || '';
      const baseInfo = originalCaption.split('Подтвердить оплату?')[0];
      
      await bot.editMessageCaption(
        `❌ ОПЛАТА ОТКЛОНЕНА\n\n` +
        baseInfo +
        `\n❌ Отклонил: ${query.from.username ? '@' + query.from.username : 'ID: ' + userId}\n` +
        `⏰ ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}`,
        {
          chat_id: chatId,
          message_id: messageId
          // БЕЗ parse_mode!
        }
      );

      await bot.answerCallbackQuery(query.id, { text: '❌ Оплата отклонена' });

      // Уведомляем пользователя
      await bot.sendMessage(
        targetUserId,
        `❌ Төлем расталмады\n\n` +
        `Өкінішке орай, төлеміңізді растай алмадық.\n\n` +
        `Мүмкін себептері:\n` +
        `• Сома дұрыс емес\n` +
        `• Чек анық емес\n` +
        `• Төлем табылмады\n\n` +
        `Қайтадан көріңіз немесе қолдау қызметіне жазыңыз.`
      );

      console.log(`❌ Оплата отклонена для пользователя ${targetUserId}`);

    } catch (error) {
      console.error('❌ Ошибка отклонения:', error);
      await bot.answerCallbackQuery(query.id, { 
        text: '❌ Ошибка при отклонении', 
        show_alert: true 
      });
    }
    return;
  }
});

// =====================================================
// 🎯 ОНБОРДИНГ ФЛОУ
// =====================================================

async function startOnboarding(chatId, userId, firstName) {
  await bot.sendMessage(
    chatId,
    `🌙 *Ассаляму Алейкум, ${firstName}!*\n\n` +
    `Imantap-қа қош келдіңіз — Рамазанға арналған жеке көмекшіңіз.\n\n` +
    `Барлығын 2 минутта баптаймыз! 🚀`,
    { parse_mode: 'Markdown' }
  );

  // Небольшая задержка для читабельности
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Шаг 1: Запрос телефона
  await bot.sendMessage(
    chatId,
    `📱 *1/3-қадам: Телефон нөміріңіз*\n\n` +
    `Жеке хабарламалар мен қолжетімділікті қалпына келтіру үшін қажет.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [[{
          text: '📱 Нөмірді жіберу',
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
    `✅ Керемет!\n\n` +
    `📍 *2/3-қадам: Қалаңыз*\n\n` +
    `Намаз уақыттарын дәл көрсету үшін геолокациямен бөлісіңіз.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          [{ text: '📍 Геолокацияны жіберу', request_location: true }],
          [{ text: '🌍 Астана' }, { text: '🌍 Алматы' }],
          [{ text: '🌍 Шымкент' }, { text: '🌍 Басқа қала' }]
        ],
        resize_keyboard: true
      }
    }
  );

  setState(userId, 'WAITING_LOCATION');
}

async function requestPromoCode(chatId, userId) {
  const session = getSession(userId);
  
  // Если пришёл по реферальной ссылке - сразу скидка
  if (session.data.referralCode) {
    await showPayment(chatId, userId, 1990, true);
    return;
  }
  
  // 🎁 Предлагаем ДЕМО или ОПЛАТУ
  await bot.sendMessage(
    chatId,
    `3️⃣ *3/3-қадам:*\n\n` +
    `Таңдаңыз:\n\n` +
    `🎁 *24 сағат тегін қолдану*\n` +
    `Барлық мүмкіндіктерді тексеріңіз!\n\n` +
    `💳 *Толық нұсқа - 2 490₸*\n` +
    `Промокод бар болса - 1 990₸\n\n` +
    `Немесе промокодты жіберіңіз:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          [{ text: '🎁 24 сағат тегін' }],
          [{ text: '💳 Төлем жасау' }],
          [{ text: '🎟️ Менде промокод бар' }]
        ],
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
    `💳 *Imantap Premium-ға қолжетімділік*\n\n` +
    `Бағасы — ${discountText}\n` +
    `✓ Рамазанның 30 күніне арналған трекер\n` +
    `✓ Алланың 99 есімі\n` +
    `✓ Құранды пара бойынша оқу\n` +
    `✓ Марапаттар мен XP жүйесі\n` +
    `✓ Лидерборд\n\n` +
    `Kaspi арқылы төлем жасап, чекті осында жіберіңіз.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 Kaspi арқылы төлем', url: kaspiLink }],
          [{ text: '📄 Менде чек бар', callback_data: 'have_receipt' }]
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
    
    // Получаем город через Reverse Geocoding (можно добавить позже)
    let city = 'Almaty';
    
    await updateUserOnboarding(userId, {
      location: { city, country: 'Kazakhstan', latitude, longitude }
    });
    
    // ✅ ПРАВИЛЬНО - используем импортированную функцию:
    await updateUserPrayerTimes(userId);
    
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

  // 🎯 ОБРАБОТКА КНОПОК-КОМАНД
  if (text === '⚙️ Баптаулар') {
    // Показываем настройки
    try {
      const user = await getUserById(userId);
      
      if (!user) {
        bot.sendMessage(chatId, '⚠️ Пайдаланушы табылмады. /start басыңыз');
        return;
      }
      
      const prayerTimesInfo = user.prayerTimes 
        ? `✅ *Намаз уақыттары:*\n🌅 Таң: ${user.prayerTimes.fajr}\n🌆 Ақшам: ${user.prayerTimes.maghrib}\n\n📅 Жаңартылды: ${new Date(user.prayerTimes.lastUpdated).toLocaleDateString('kk-KZ')}`
        : '⚠️ Намаз уақыттары белгіленбеген';
      
      const message = `⚙️ *Сіздің баптауларыңыз:*\n\n📍 *Қала:* ${user.location?.city || 'Белгісіз'}\n🌍 *Ел:* ${user.location?.country || 'Белгісіз'}\n\n${prayerTimesInfo}\n\n🔔 *Хабарландырулар:*\n${user.notificationSettings?.ramadanReminders !== false ? '✅ Қосулы' : '❌ Өшірулі'}\n\nӨзгерту үшін төмендегі батырмаларды басыңыз:`;
      
      bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📍 Қаланы өзгерту', callback_data: 'change_city' }],
            [{ text: user.notificationSettings?.ramadanReminders !== false ? '🔕 Хабарландыруды өшіру' : '🔔 Хабарландыруды қосу', callback_data: 'toggle_notifications' }],
            [{ text: '🔄 Уақытты жаңарту', callback_data: 'update_prayer_times' }]
          ]
        }
      });
    } catch (error) {
      console.error('settings ошибка:', error);
      bot.sendMessage(chatId, '❌ Қате. Қайта көріңіз.');
    }
    return;
  }
  
  if (text === '📊 Статистика') {
    // Показываем статистику
    try {
      const user = await getUserById(userId);
      
      if (!user) {
        bot.sendMessage(chatId, '⚠️ Пайдаланушы табылмады. /start басыңыз');
        return;
      }
      
      bot.sendMessage(chatId, 
        `📊 *Статистика:*\n\n` +
        `👤 User ID: ${user.userId}\n` +
        `🎁 Промокод: ${user.promoCode}\n` +
        `👥 Шақырылғандар: ${user.invitedCount}\n` +
        `📅 Тіркелген күн: ${user.createdAt.toLocaleDateString('kk-KZ')}`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('stats ошибка:', error);
      bot.sendMessage(chatId, '❌ Қате. Қайта көріңіз.');
    }
    return;
  }
  
  if (text === '🎁 Менің промокодым') {
    // Показываем промокод
    try {
      const user = await getUserById(userId);
      
      if (!user) {
        bot.sendMessage(chatId, '⚠️ Пайдаланушы табылмады. /start басыңыз');
        return;
      }
      
      const botUsername = 'imantap_bot';
      const referralLink = `https://t.me/${botUsername}?start=ref_${user.promoCode}`;
      
      const message = `🎁 *Сіздің промокодыңыз:*\n\n` +
        `📋 \`${user.promoCode}\`\n\n` +
        `👥 Шақырылғандар: ${user.invitedCount}\n\n` +
        `${referralLink}\n\n` +
        `Достарыңызды шақырыңыз! 🚀`;
      
      bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('mycode ошибка:', error);
      bot.sendMessage(chatId, '❌ Қате. Қайта көріңіз.');
    }
    return;
  }

  // Выбор города вручную
  if (state === 'WAITING_LOCATION') {
    let city = text.replace(/[🌍📍]/g, '').trim();
    
    if (!city) {
      await bot.sendMessage(chatId, 'Қала атауын жазыңыз:', {
        reply_markup: { remove_keyboard: true }
      });
      setState(userId, 'WAITING_CITY_NAME');
      return;
    }
    
    await updateUserOnboarding(userId, {
      location: { city, country: 'Kazakhstan', latitude: null, longitude: null }
    });
    
    // ✅ ДОБАВЬТЕ обновление времен намазов
    await updateUserPrayerTimes(userId);
    
    await requestPromoCode(chatId, userId);
    return;
  }

  // Ввод названия города
  if (state === 'WAITING_CITY_NAME') {
    const city = text.trim();
    await updateUserOnboarding(userId, {
      location: { city, country: 'Kazakhstan', latitude: null, longitude: null }
    });
    
    // ✅ ДОБАВЬТЕ обновление времен намазов
    await updateUserPrayerTimes(userId);
    
    await requestPromoCode(chatId, userId);
    return;
  }

  // 📍 СМЕНА ГОРОДА (через настройки)
  if (state === 'CHANGING_CITY') {
    let city = text.trim();
    
    if (city === '❌ Болдырмау') {
      await bot.sendMessage(chatId, 'Болдырылды ✅', {
        reply_markup: {
          keyboard: [
            [{ 
              text: '📱 ImanTap ашу', 
              web_app: { url: `${MINI_APP_URL}?tgWebAppStartParam=${userId}` }
            }],
            ['⚙️ Баптаулар', '📊 Статистика'],
            ['🎁 Менің промокодым']
          ],
          resize_keyboard: true
        }
      });
      clearSession(userId);
      return;
    }
    
    if (!city) {
      await bot.sendMessage(chatId, '❌ Қала атауын жазыңыз');
      return;
    }
    
    try {
      await updateUserOnboarding(userId, {
        location: { city, country: 'Kazakhstan', latitude: null, longitude: null }
      });
      
      // ✅ Обновляем времена намазов для нового города
      const success = await updateUserPrayerTimes(userId);
      
      if (success) {
        const user = await getUserById(userId);
        await bot.sendMessage(chatId, 
          `✅ Қала өзгертілді: *${city}*\n\n` +
          `🌅 Таң намазы: ${user.prayerTimes.fajr}\n` +
          `🌆 Ақшам намазы: ${user.prayerTimes.maghrib}`,
          { 
            parse_mode: 'Markdown',
            reply_markup: {
              keyboard: [
                [{ 
                  text: '📱 ImanTap ашу', 
                  web_app: { url: `${MINI_APP_URL}?tgWebAppStartParam=${userId}` }
                }],
                ['⚙️ Баптаулар', '📊 Статистика'],
                ['🎁 Менің промокодым']
              ],
              resize_keyboard: true
            }
          }
        );
      } else {
        await bot.sendMessage(chatId, 
          `✅ Қала өзгертілді: *${city}*\n\n⚠️ Намаз уақыттары табылмады. /settings арқылы қайталап көріңіз.`, 
          {
            parse_mode: 'Markdown',
            reply_markup: {
              keyboard: [
                [{ 
                  text: '📱 ImanTap ашу', 
                  web_app: { url: `${MINI_APP_URL}?tgWebAppStartParam=${userId}` }
                }],
                ['⚙️ Баптаулар', '📊 Статистика'],
                ['🎁 Менің промокодым']
              ],
              resize_keyboard: true
            }
          }
        );
      }
      
      clearSession(userId);
    } catch (error) {
      console.error('CHANGING_CITY ошибка:', error);
      await bot.sendMessage(chatId, '❌ Қате. Қайталап көріңіз.');
    }
    return;
  }

  // 💳 Обработка кнопки покупки из demo режима
  if (text === '💳 Толық нұсқаны сатып алу') {
    const user = await getUserById(userId);
    const session = getSession(userId);
    
    // Если пришёл по реферальной ссылке - сразу скидка
    if (session.data.referralCode || user?.referredBy) {
      await showPayment(chatId, userId, 1990, true);
      return;
    }
    
    // 💳 Показываем ТОЛЬКО варианты оплаты (БЕЗ demo)
    await bot.sendMessage(
      chatId,
      `💳 *Толық нұсқаға өту*\n\n` +
      `Imantap Premium бағасы:\n\n` +
      `• Қалыпты баға: *2 490₸*\n` +
      `• Промокод бар болса: *1 990₸*\n\n` +
      `Промокод бар ма?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [
            [{ text: '💳 Төлем жасау' }],
            [{ text: '🎟️ Менде промокод бар' }]
          ],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
    
    setState(userId, 'WAITING_PROMO');
    return;
  }

  // Обработка промокода
  if (state === 'WAITING_PROMO') {
  
    // 🎁 ДЕМО-ДОСТУП
    if (text === '🎁 24 сағат тегін') {
      try {
        const demoExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        
        await updateUserOnboarding(userId, {
          accessType: 'demo',
          demoExpiresAt: demoExpiresAt,
          onboardingCompleted: true,
          paymentStatus: 'unpaid'
        });
        
        await bot.sendMessage(
          chatId,
          `🎉 *Демо-режим қосылды!*\n\n` +
          `Сізде *24 сағат* тегін қолжетімділік бар.\n\n` +
          `Барлық мүмкіндіктерді қолданып көріңіз! 🌙\n\n` +
          `Демо аяқталғаннан кейін төлем жасауға болады.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              keyboard: [
                [{
                  text: "📱 Рамазан трекерін ашу",
                  web_app: { url: `${MINI_APP_URL}?tgWebAppStartParam=${userId}` }
                }],
                [{ text: "💳 Толық нұсқаны сатып алу" }] // ✅ Добавили кнопку!
              ],
              resize_keyboard: true
            }
          }
        );
        
        console.log(`🎁 Демо-доступ активирован для пользователя ${userId} до ${demoExpiresAt.toISOString()}`);
        clearSession(userId);
        
      } catch (error) {
        console.error('❌ Ошибка активации демо:', error);
        await bot.sendMessage(chatId, '❌ Қате орын алды. Қайталап көріңіз.');
      }
      return;
    }
    
    // 💳 ОПЛАТА СРАЗУ
    if (text === '💳 Төлем жасау' || text === '❌ Жоқ') {
      await showPayment(chatId, userId, 2490, false);
      return;
    }
    
    // 🎟️ ВВОД ПРОМОКОДА
    if (text === '🎟️ Менде промокод бар') {
      await bot.sendMessage(
        chatId,
        `🎟️ Промокодты жіберіңіз:`,
        {
          reply_markup: {
            keyboard: [['❌ Артқа қайту']],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        }
      );
      setState(userId, 'ENTERING_PROMO');
      return;
    }
    
    // ❌ НАЗАД (из ввода промокода)
    if (text === '❌ Артқа қайту') {
      await requestPromoCode(chatId, userId);
      return;
    }
    
    // Если написали что-то другое - считаем что это промокод
    const promoCode = text.toUpperCase().trim();
    const check = await checkPromoCode(promoCode, userId);
    
    if (check.valid) {
      await updateUserOnboarding(userId, {
        usedPromoCode: promoCode,
        hasDiscount: true
      });
      
      await markPromoCodeAsUsed(promoCode, userId);
      
      await bot.sendMessage(
        chatId,
        `✅ Промокод қабылданды!\n\n` +
        `Сізге -500₸ жеңілдік берілді:\n` +
        `2490₸ → 1990₸`,
        { parse_mode: 'Markdown' }
      );
      
      await showPayment(chatId, userId, 1990, true);
    } else {
      // Ошибка промокода
      let errorMsg = '❌ Промокод қате.';
      if (check.reason === 'not_found') {
        errorMsg = '❌ Промокод табылмады.';
      } else if (check.reason === 'already_used') {
        errorMsg = '❌ Бұл промокод қолданылған.';
      } else if (check.reason === 'own_code') {
        errorMsg = '❌ Өз промокодыңызды қолдануға болмайды.';
      } else if (check.reason === 'owner_not_paid') {
        errorMsg = '❌ Промокод иесі төлем жасамаған.';
      }
      errorMsg += '\n\nҚайталап көріңіз немесе артқа қайтыңыз.';
      
      await bot.sendMessage(chatId, errorMsg, { parse_mode: 'Markdown' });
    }
    
    return;
  }

  // 🎟️ СОСТОЯНИЕ ВВОДА ПРОМОКОДА (новое!)
  if (state === 'ENTERING_PROMO') {
    if (text === '❌ Артқа қайту') {
      await requestPromoCode(chatId, userId);
      return;
    }
    
    const promoCode = text.toUpperCase().trim();
    const check = await checkPromoCode(promoCode, userId);
    
    if (check.valid) {
      await updateUserOnboarding(userId, {
        usedPromoCode: promoCode,
        hasDiscount: true
      });
      
      await markPromoCodeAsUsed(promoCode, userId);
      
      await bot.sendMessage(
        chatId,
        `✅ Промокод қабылданды!\n\n` +
        `Сізге -500₸ жеңілдік берілді:\n` +
        `2490₸ → 1990₸`,
        { parse_mode: 'Markdown' }
      );
      
      await showPayment(chatId, userId, 1990, true);
    } else {
      let errorMsg = '❌ Промокод қате.';
      if (check.reason === 'not_found') {
        errorMsg = '❌ Промокод табылмады.';
      } else if (check.reason === 'already_used') {
        errorMsg = '❌ Бұл промокод қолданылған.';
      } else if (check.reason === 'own_code') {
        errorMsg = '❌ Өз промокодыңызды қолдануға болмайды.';
      } else if (check.reason === 'owner_not_paid') {
        errorMsg = '❌ Промокод иесі төлем жасамаған.';
      }
      errorMsg += '\n\nҚайталап көріңіз немесе артқа қайтыңыз.';
      
      await bot.sendMessage(chatId, errorMsg, { 
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [['❌ Артқа қайту']],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      });
    }
    
    return;
  }
});

// =====================================================
// 📸 ОБРАБОТКА ЧЕКОВ (ФОТО И ДОКУМЕНТЫ)
// =====================================================

// Обработка фото
bot.on('photo', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const state = getState(userId);

  if (state === 'WAITING_RECEIPT') {
    const photo = msg.photo[msg.photo.length - 1]; // Лучшее качество
    const fileId = photo.file_id;

    await handleReceipt(userId, chatId, fileId, 'photo');
  } else {
    bot.sendMessage(chatId, 'Бастау үшін /start деп жазыңыз.');
  }
});

// Обработка документов (PDF, скриншоты)
bot.on('document', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const state = getState(userId);

  if (state === 'WAITING_RECEIPT') {
    const document = msg.document;
    const fileId = document.file_id;
    const fileName = document.file_name;

    // Проверяем что это изображение или PDF
    const validTypes = ['image/', 'application/pdf'];
    const isValid = validTypes.some(type => 
      document.mime_type?.startsWith(type)
    );

    if (!isValid) {
      bot.sendMessage(
        chatId,
        '❌ Фото немесе PDF құжат жіберіңіз.'
      );
      return;
    }

    await handleReceipt(userId, chatId, fileId, 'document', fileName);
  } else {
    bot.sendMessage(chatId, 'Бастау үшін /start деп жазыңыз.');
  }
});

// Универсальная функция обработки чека
async function handleReceipt(userId, chatId, fileId, fileType, fileName = null) {
  try {
    // Сохраняем данные о чеке
    await updateUserOnboarding(userId, {
      receiptFileId: fileId,
      receiptFileType: fileType,
      receiptFileName: fileName,
      receiptSubmittedAt: new Date(),
      paymentStatus: 'pending',
      accessType: null,
      demoExpiresAt: null
    });

    await bot.sendMessage(
      chatId,
      `✅ *Чек қабылданды!*\n\n` +
      `Төлеміңіз тексеруге жіберілді.\n` +
      `Әдетте бұл 30 минутқа дейін созылады.\n\n` +
      `Қолжетімділік ашылған кезде хабарлаймыз! 🎉`,
      { 
        parse_mode: 'Markdown',
        reply_markup: { remove_keyboard: true }
      }
    );

    // Уведомляем всех админов/менеджеров
    await notifyAdminsNewPayment(userId, fileId, fileType);

    clearSession(userId);

  } catch (error) {
    console.error('❌ Ошибка сохранения чека:', error);
    bot.sendMessage(chatId, '❌ Қате пайда болды. Қайтадан жіберіңіз.');
  }
}

// =====================================================
// 👨‍💼 УВЕДОМЛЕНИЕ ВСЕХ АДМИНОВ
// =====================================================

async function notifyAdminsNewPayment(userId, fileId, fileType) {
  try {
    const user = await getUserById(userId);
    const adminIds = await getAdmins();
    
    const discountText = user.hasDiscount 
      ? `💰 Сумма: ~~2490₸~~ → *${user.paidAmount}₸* (скидка!)` 
      : `💰 Сумма: *${user.paidAmount}₸*`;

    const caption =
      `🔔 *Новый платёж на проверке*\n\n` +
      `👤 User ID: \`${userId}\`\n` +
      `👤 Имя: ${user.username || 'н/д'}\n` +
      `📱 Телефон: ${user.phoneNumber || 'н/д'}\n` +
      `📍 Город: ${user.location?.city || 'не указан'}\n` +
      `${discountText}\n` +
      `🎟️ Промокод: ${user.usedPromoCode || user.referredBy || 'нет'}\n` +
      `⏰ Отправлено: ${new Date().toLocaleString('ru-RU')}\n\n` +
      `Подтвердить оплату?`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Подтвердить', callback_data: `approve_${userId}` },
          { text: '❌ Отклонить', callback_data: `reject_${userId}` }
        ]
      ]
    };

    // Отправляем всем админам/менеджерам
    for (const adminId of adminIds) {
      try {
        if (fileType === 'photo') {
          await bot.sendPhoto(adminId, fileId, {
            caption,
            parse_mode: 'Markdown',
            reply_markup: keyboard
          });
        } else {
          // Для документов отправляем файл
          await bot.sendDocument(adminId, fileId, {
            caption,
            parse_mode: 'Markdown',
            reply_markup: keyboard
          });
        }
        
        console.log(`📤 Уведомление отправлено админу ${adminId}`);
      } catch (error) {
        console.error(`❌ Не удалось отправить админу ${adminId}:`, error.message);
      }
    }
  } catch (error) {
    console.error('❌ Ошибка уведомления админов:', error);
  }
}

// ===== КОМАНДЫ БОТА =====

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const from = msg.from;
  const userId = from?.id;
  const param = match && match[1] ? match[1] : null;

  if (!userId) {
    bot.sendMessage(chatId, '❌ ID анықтау мүмкін болмады');
    return;
  }

  try {
    const MAIN_ADMIN = parseInt(process.env.MAIN_ADMIN_ID);
    
    // 🔥 АВТОМАТИЧЕСКАЯ НАСТРОЙКА ДЛЯ АДМИНА
    if (userId === MAIN_ADMIN) {
      let user = await getUserById(userId);
      
      if (!user) {
        user = await getOrCreateUser(userId, from.username);
      }
      
      // Если админ ещё не завершил онбординг - завершаем автоматически
      if (!user.onboardingCompleted || user.paymentStatus !== 'paid') {
        await updateUserOnboarding(userId, {
          phoneNumber: from.phone_number || '+77001234567',
          location: {
            city: 'Астана',
            country: 'Қазақстан',
            latitude: 51.1694,
            longitude: 71.4491
          },
          onboardingCompleted: true,
          paymentStatus: 'paid',
          paidAmount: 0,
          hasDiscount: false
        });
        
        console.log('✅ Админ автоматически получил доступ');
      }
      
      // Показываем приветствие
      bot.sendMessage(
        chatId,
        `Ассаляму Алейкум, ${from.first_name}! 👑\n\n` +
        `Вы администратор Imantap.\n\n` +
        `Трекерді ашу үшін төмендегі батырманы басыңыз:`,
        {
          reply_markup: {
            keyboard: [
              [{
                text: "📱 Рамазан трекерін ашу",
                web_app: { url: `${MINI_APP_URL}?tgWebAppStartParam=${userId}` }
              }]
            ],
            resize_keyboard: true
          }
        }
      );
      return;
    }

    // Получаем или создаём пользователя
    let user = await getUserById(userId);
    
    if (!user) {
      user = await getOrCreateUser(userId, from.username);
    }

    // 🎁 DEMO РЕЖИМ - показываем кнопку покупки
    if (user.accessType === 'demo' && user.demoExpiresAt && new Date() < new Date(user.demoExpiresAt)) {
      const hoursLeft = Math.floor((new Date(user.demoExpiresAt) - new Date()) / (1000 * 60 * 60));
      
      bot.sendMessage(
        chatId,
        `Сәлем, ${from.first_name}! 👋\n\n` +
        `🎁 *Demo-режим қосулы* (${hoursLeft} сағат қалды)\n\n` +
        `Толық нұсқаға өту үшін төлем жасаңыз 👇`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [
              [{
                text: "📱 Рамазан трекерін ашу",
                web_app: { url: `${MINI_APP_URL}?tgWebAppStartParam=${userId}` } // ✅ userId (НЕ targetUserId)
              }],
              [{ text: "💳 Толық нұсқаны сатып алу" }] // ✅ Точный текст
            ],
            resize_keyboard: true
          }
        }
      );
      return;
    }

    // 🔥 ПРОВЕРКА 1: Если пользователь УЖЕ завершил онбординг И оплатил
    if (user.onboardingCompleted && user.paymentStatus === 'paid') {
      bot.sendMessage(
        chatId,
        `Ассаляму Алейкум, ${from.first_name}! 🤲\n\n` +
        `Imantap-қа қайта қош келдіңіз!\n\n` +
        `Трекерді ашу үшін төмендегі батырманы басыңыз:`,
        {
          reply_markup: {
            keyboard: [
              [{
                text: "📱 Рамазан трекерін ашу",
                web_app: { url: `${MINI_APP_URL}?tgWebAppStartParam=${userId}` }
              }]
            ],
            resize_keyboard: true
          }
        }
      );
      return;
    }

    // 🔥 ПРОВЕРКА 2: Если есть реферальная ссылка
    let referralCode = null;
    if (param && param.startsWith('ref_')) {
      referralCode = param.substring(4);
      
      // Проверяем что это не свой промокод
      if (referralCode.toUpperCase() === user.promoCode) {
        bot.sendMessage(
          chatId,
          "⚠️ Өз промокодыңызды пайдалануға болмайды!"
        );
        return;
      }

      // Проверяем существует ли такой промокод
      const inviter = await getUserByPromoCode(referralCode);
      
      if (inviter) {
        // Сохраняем реферал
        await updateUserOnboarding(userId, {
          referredBy: referralCode
        });
        
        bot.sendMessage(
          chatId,
          `🎁 *Сізде реферал сілтемесі бар!*\n\n` +
          `Досыңыз сізді шақырды.\n` +
          `Сіз -500₸ жеңілдік аласыз!\n\n` +
          `Баптауды бастайық! 🚀`,
          { parse_mode: 'Markdown' }
        );
      }
    }

    // 🔥 ПРОВЕРКА 3: Определяем с какого шага начать онбординг
    
    // Если НЕТ телефона - начинаем с телефона
    if (!user.phoneNumber) {
      await startOnboarding(chatId, userId, from.first_name);
      return;
    }
    
    // Если НЕТ города - запрашиваем город
    if (!user.location || !user.location.city) {
      await requestLocation(chatId, userId);
      return;
    }
    
    // Если НЕТ промокода И НЕТ реферала - спрашиваем промокод
    if (!user.usedPromoCode && !user.referredBy) {
      await requestPromoCode(chatId, userId);
      return;
    }
    
    // Если всё есть, но НЕ оплачено - показываем оплату
    if (user.paymentStatus !== 'paid') {
      const price = (user.hasDiscount || user.referredBy) ? 1990 : 2490;
      const hasDiscount = !!(user.hasDiscount || user.referredBy);
      await showPayment(chatId, userId, price, hasDiscount);
      return;
    }

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
    bot.sendMessage(chatId, '❌ ID анықтау мүмкін болмады');
    return;
  }

  try {
    const user = await getUserById(userId);

    if (!user) {
      bot.sendMessage(chatId, '❌ Пайдаланушы табылмады. /start деп жазыңыз.');
      return;
    }

    const botUsername = 'imantap_bot';
    const referralLink = `https://t.me/${botUsername}?start=ref_${user.promoCode}`;
    
    const message = 
      `🎁 Сіздің реферал кодыңыз:\n\n` +
      `📋 Код: ${user.promoCode}\n` +
      `👥 Шақырылғандар: ${user.invitedCount}\n\n` +
      `🔗 Реферал сілтеме:\n${referralLink}\n\n` +
      `Досыңызбен бөлісіңіз!`;

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
    bot.sendMessage(chatId, '❌ ID анықтау мүмкін болмады');
    return;
  }

  try {
    const user = await getUserById(userId);

    if (!user) {
      bot.sendMessage(chatId, '❌ Пайдаланушы табылмады. /start деп жазыңыз.');
      return;
    }

    bot.sendMessage(
      chatId,
      `📊 Сіздің статистикаңыз:\n\n` +
      `👤 ID: ${user.userId}\n` +
      `📋 Промокод: ${user.promoCode}\n` +
      `👥 Шақырылғандар: ${user.invitedCount}\n` +
      `📅 Тіркелген күні: ${user.createdAt.toLocaleDateString('kk-KZ')}`
    );

  } catch (error) {
    console.error('❌ Ошибка в /stats:', error);
    bot.sendMessage(chatId, '❌ Қате орын алды. Қайталап көріңіз.');
  }
});

// ⚙️ КОМАНДА /settings - Баптаулар
bot.onText(/\/settings/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  
  if (!userId) {
    bot.sendMessage(chatId, '❌ User ID не найден');
    return;
  }
  
  try {
    const user = await getUserById(userId);
    
    if (!user) {
      bot.sendMessage(chatId, '⚠️ Пользователь не найден. Напишите /start');
      return;
    }
    
    const prayerTimesInfo = user.prayerTimes 
      ? `✅ *Намаз уақыттары:*
🌅 Таң: ${user.prayerTimes.fajr}
🌆 Ақшам: ${user.prayerTimes.maghrib}

📅 Жаңартылды: ${new Date(user.prayerTimes.lastUpdated).toLocaleDateString('kk-KZ')}`
      : '⚠️ Намаз уақыттары белгіленбеген';
    
    const message = `⚙️ *Сіздің баптауларыңыз:*

📍 *Қала:* ${user.location?.city || 'Белгісіз'}
🌍 *Ел:* ${user.location?.country || 'Белгісіз'}

${prayerTimesInfo}

🔔 *Хабарландырулар:*
${user.notificationSettings?.ramadanReminders !== false ? '✅ Қосулы' : '❌ Өшірулі'}

Өзгерту үшін төмендегі батырмаларды басыңыз:`;
    
    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📍 Қаланы өзгерту', callback_data: 'change_city' }],
          [{ text: user.notificationSettings?.ramadanReminders !== false ? '🔕 Хабарландыруды өшіру' : '🔔 Хабарландыруды қосу', callback_data: 'toggle_notifications' }],
          [{ text: '🔄 Уақытты жаңарту', callback_data: 'update_prayer_times' }]
        ]
      }
    });
  } catch (error) {
    console.error('settings ошибка:', error);
    bot.sendMessage(chatId, '❌ Қате. Қайта көріңіз.');
  }
});

// ===== КОМАНДЫ УПРАВЛЕНИЯ МЕНЕДЖЕРАМИ (только главный админ) =====

// /addmanager - добавить менеджера
bot.onText(/\/addmanager(?:\s+(\d+))?/, async (msg, match) => {
  const adminId = msg.from.id;
  const chatId = msg.chat.id;
  const MAIN_ADMIN = parseInt(process.env.MAIN_ADMIN_ID);

  if (adminId !== MAIN_ADMIN) {
    bot.sendMessage(chatId, '❌ Только главный админ может добавлять менеджеров');
    return;
  }

  const managerId = match && match[1] ? parseInt(match[1]) : null;

  if (!managerId) {
    bot.sendMessage(
      chatId,
      `📝 *Как добавить менеджера:*\n\n` +
      `1. Попросите менеджера написать боту @userinfobot\n` +
      `2. Скопируйте его Telegram ID\n` +
      `3. Отправьте команду:\n` +
      `\`/addmanager ID\`\n\n` +
      `Пример: \`/addmanager 123456789\``,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  try {
    const result = await addManager(managerId, adminId);
    
    if (result.success) {
      bot.sendMessage(
        chatId,
        `✅ *Менеджер добавлен!*\n\n` +
        `ID: \`${managerId}\`\n\n` +
        `Теперь он будет получать уведомления о новых платежах.`,
        { parse_mode: 'Markdown' }
      );
      
      // Уведомляем нового менеджера
      try {
        await bot.sendMessage(
          managerId,
          `🎉 *Вы добавлены как менеджер Imantap!*\n\n` +
          `Теперь вы можете:\n` +
          `✅ Подтверждать оплаты\n` +
          `❌ Отклонять платежи\n` +
          `📋 Просматривать статистику\n\n` +
          `Команды:\n` +
          `/pending - список ожидающих`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        // Менеджер ещё не запустил бота
      }
    } else {
      bot.sendMessage(chatId, `❌ ${result.message}`);
    }
  } catch (error) {
    console.error('❌ Ошибка добавления менеджера:', error);
    bot.sendMessage(chatId, '❌ Ошибка добавления');
  }
});

// /removemanager - удалить менеджера
bot.onText(/\/removemanager(?:\s+(\d+))?/, async (msg, match) => {
  const adminId = msg.from.id;
  const chatId = msg.chat.id;
  const MAIN_ADMIN = parseInt(process.env.MAIN_ADMIN_ID);

  if (adminId !== MAIN_ADMIN) {
    bot.sendMessage(chatId, '❌ Только главный админ может удалять менеджеров');
    return;
  }

  const managerId = match && match[1] ? parseInt(match[1]) : null;

  if (!managerId) {
    bot.sendMessage(
      chatId,
      `Используйте: \`/removemanager ID\`\n\nПример: \`/removemanager 123456789\``,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  try {
    const result = await removeManager(managerId);
    
    if (result.success) {
      bot.sendMessage(chatId, `✅ Менеджер удалён: \`${managerId}\``, { parse_mode: 'Markdown' });
      
      // Уведомляем удалённого менеджера
      try {
        await bot.sendMessage(
          managerId,
          `⚠️ Вы удалены из списка менеджеров Imantap.`
        );
      } catch (e) {
        // Игнорируем
      }
    } else {
      bot.sendMessage(chatId, `❌ ${result.message}`);
    }
  } catch (error) {
    console.error('❌ Ошибка удаления менеджера:', error);
    bot.sendMessage(chatId, '❌ Ошибка удаления');
  }
});

// /managers - список всех менеджеров
bot.onText(/\/managers/, async (msg) => {
  const adminId = msg.from.id;
  const chatId = msg.chat.id;
  const MAIN_ADMIN = parseInt(process.env.MAIN_ADMIN_ID);

  if (adminId !== MAIN_ADMIN) {
    bot.sendMessage(chatId, '❌ Доступ запрещён');
    return;
  }

  try {
    const managers = await listManagers();
    
    if (managers.length === 0) {
      bot.sendMessage(chatId, '📋 Менеджеры не добавлены');
      return;
    }

    let message = `👥 *Список менеджеров: ${managers.length}*\n\n`;
    
    managers.forEach((m, index) => {
      message += `${index + 1}. ID: \`${m.telegramId}\`\n`;
      if (m.username) message += `   @${m.username}\n`;
      message += `   Добавлен: ${new Date(m.addedAt).toLocaleDateString('ru-RU')}\n\n`;
    });

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Ошибка загрузки менеджеров:', error);
    bot.sendMessage(chatId, '❌ Ошибка загрузки');
  }
});

// /pending - обновляем для всех админов/менеджеров
bot.onText(/\/pending/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  const hasAccess = await isAdmin(userId);
  if (!hasAccess) {
    bot.sendMessage(chatId, '❌ Доступ запрещён');
    return;
  }

  try {
    const pending = await getPendingPayments();

    if (pending.length === 0) {
      bot.sendMessage(chatId, '✅ Нет ожидающих платежей');
      return;
    }

    let message = `📋 *Ожидают проверки: ${pending.length}*\n\n`;

    pending.forEach((user, index) => {
      message += 
        `${index + 1}. User \`${user.userId}\`\n` +
        `   💰 ${user.paidAmount}₸\n` +
        `   📍 ${user.location?.city || 'н/д'}\n` +
        `   ⏰ ${new Date(user.receiptSubmittedAt).toLocaleString('ru-RU')}\n\n`;
    });

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('❌ Ошибка /pending:', error);
    bot.sendMessage(chatId, '❌ Ошибка загрузки данных');
  }
});

// ===== ВРЕМЕННАЯ КОМАНДА ДЛЯ ТЕСТА ДЕМО =====
bot.onText(/\/activatedemo(?:\s+(\d+))?/, async (msg, match) => {
  const adminId = msg.from.id;
  const chatId = msg.chat.id;
  const MAIN_ADMIN = parseInt(process.env.MAIN_ADMIN_ID);

  if (adminId !== MAIN_ADMIN) {
    return; // Только админ может использовать
  }

  const targetUserId = match && match[1] ? parseInt(match[1]) : adminId;

  try {
    const demoExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // +24 часа
    
    await updateUserOnboarding(targetUserId, {
      accessType: 'demo',
      demoExpiresAt: demoExpiresAt,
      paymentStatus: 'unpaid', // Важно!
      onboardingCompleted: true
    });

    bot.sendMessage(
      chatId,
      `✅ Демо активировано для user ${targetUserId}\n\n` +
      `Истекает: ${demoExpiresAt.toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}\n\n` +
      `Откройте Mini App для проверки.`
    );
    
    console.log(`🎁 Демо активировано админом для ${targetUserId}`);
  } catch (error) {
    console.error('❌ Ошибка активации демо:', error);
    bot.sendMessage(chatId, '❌ Ошибка активации');
  }
});

// ===== ТЕСТОВАЯ КОМАНДА ДЛЯ ПРОВЕРКИ ДЕМО =====
bot.onText(/\/checkdemo/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  try {
    const user = await getUserById(userId);
    const access = await getUserAccess(userId);
    
    const message = 
      `🔍 *Проверка доступа*\n\n` +
      `👤 User ID: ${userId}\n` +
      `📋 accessType: ${user?.accessType || 'н/д'}\n` +
      `⏰ demoExpiresAt: ${user?.demoExpiresAt ? new Date(user.demoExpiresAt).toLocaleString('ru-RU') : 'н/д'}\n` +
      `💳 paymentStatus: ${user?.paymentStatus || 'н/д'}\n` +
      `✅ onboardingCompleted: ${user?.onboardingCompleted || false}\n\n` +
      `*API ответ:*\n` +
      `hasAccess: ${access.hasAccess}\n` +
      `paymentStatus: ${access.paymentStatus}\n` +
      `demoExpires: ${access.demoExpires || 'н/д'}`;
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    bot.sendMessage(chatId, '❌ Ошибка: ' + error.message);
  }
});

// ===== HTTP API СЕРВЕР =====

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  
  // ✅ УСИЛЕННАЯ CORS ПОЛИТИКА
  const allowedOrigins = process.env.NODE_ENV === 'production' 
    ? [
        'https://imantap-production-6776.up.railway.app',
        'https://web.telegram.org'
      ]
    : [
        'https://imantap-production-6776.up.railway.app',
        'https://web.telegram.org',
        'http://localhost:3000',
        'http://localhost:5173'
      ];

  const origin = req.headers.origin;

  // ✅ Проверяем origin
  if (!origin || !allowedOrigins.includes(origin)) {
    // Если origin неизвестный - блокируем
    if (req.method !== 'GET' && req.method !== 'OPTIONS') {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ 
        success: false, 
        error: 'Forbidden: Invalid origin' 
      }));
      return;
    }
  }

  // ✅ Разрешаем только проверенные origins
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

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
      // ✅ Добавить ЭТУ ПРОВЕРКУ
      if (!checkRateLimit(userId)) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ 
          success: false, 
          error: 'Too many requests. Please try again later.' 
        }));
        return;
      }

      
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
      // ✅ Добавить ЭТУ ПРОВЕРКУ
      if (!checkRateLimit(userId)) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ 
          success: false, 
          error: 'Too many requests. Please try again later.' 
        }));
        return;
      }
      
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

    // 🆕 GET /api/notify-purchase/:userId - уведомить о желании купить
    const notifyMatch = url.pathname.match(/^\/api\/notify-purchase\/(\d+)$/);
    if (req.method === 'GET' && notifyMatch) {
      const userId = parseInt(notifyMatch[1]);
      
      if (!userId || isNaN(userId)) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = 400;
        res.end(JSON.stringify({
          success: false,
          error: 'Invalid userId'
        }));
        return;
      }

      try {
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

        // Отправляем сообщение пользователю
        await bot.sendMessage(
          userId,
          `💳 *Толық нұсқаға өту*\n\n` +
          `Imantap Premium мүмкіндіктері ұнады ма? 🌙\n\n` +
          `✓ Рамазанның 30 күніне арналған трекер\n` +
          `✓ Алланың 99 есімі\n` +
          `✓ Құранды пара бойынша оқу\n` +
          `✓ Марапаттар мен XP жүйесі\n` +
          `✓ Лидерборд\n\n` +
          `Бағасы: *2 490₸*\n` +
          `Промокод бар болса: *1 990₸*\n\n` +
          `Төлем жасау үшін төмендегі батырманы басыңыз 👇`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              keyboard: [
                [{
                  text: "📱 Рамазан трекерін ашу",
                  web_app: { url: `${MINI_APP_URL}?tgWebAppStartParam=${userId}` }
                }],
                [{ text: "💳 Толық нұсқаны сатып алу" }]
              ],
              resize_keyboard: true
            }
          }
        );

        console.log(`💳 Отправлено предложение покупки пользователю ${userId}`);

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          message: 'Notification sent'
        }));

      } catch (error) {
        console.error('❌ Ошибка отправки уведомления:', error);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = 500;
        res.end(JSON.stringify({
          success: false,
          error: 'Failed to send notification'
        }));
      }
      return;
    }

    // POST /api/user/:userId/sync - синхронизировать прогресс
    const syncMatch = url.pathname.match(/^\/api\/user\/(\d+)\/sync$/);
    if (req.method === 'POST' && syncMatch) {
      const userId = parseInt(syncMatch[1]);
      if (!checkRateLimit(userId)) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ 
          success: false, 
          error: 'Too many requests. Please try again later.' 
        }));
        return;
      }
      
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
