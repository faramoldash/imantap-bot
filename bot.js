// bot.js
import TelegramBot from 'node-telegram-bot-api';
import http from 'http';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import geoTz from 'geo-tz';
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
  getPendingPayments,
  addUserXP,
  getGlobalLeaderboard,
  getUserRank,
  getFriendsLeaderboard,
  getCountries,
  getCities,
  getFilteredLeaderboard
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
import { 
  createCircle, 
  getUserCircles, 
  getCircleDetails,
  inviteToCircle,
  acceptInvite,
  declineInvite,
  joinByCode,
  leaveCircle,
  removeMember,
  deleteCircle
} from './services/circleService.js';

// Экранирование специальных символов для Markdown
function escapeMarkdown(text) {
  if (!text) return '';
  return text.toString()
    .replace(/\_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\~/g, '\\~')
    .replace(/\`/g, '\\`')
    .replace(/\>/g, '\\>')
    .replace(/\#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/\-/g, '\\-')
    .replace(/\=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\./g, '\\.')
    .replace(/\!/g, '\\!');
}

// Форматирование цены с пробелом для тысяч (2490 → 2 490)
function formatPrice(price) {
  return price.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}


// ✅ Функция определения города по координатам с User-Agent
async function getCityFromCoordinates(latitude, longitude) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&accept-language=en`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'ImanTap/1.0 (Telegram Bot; https://t.me/imantap_bot)'
      }
    });
    
    if (!response.ok) {
      throw new Error('Nominatim API error');
    }
    
    const data = await response.json();
    
    const city = data.address?.city || 
                 data.address?.town || 
                 data.address?.village || 
                 data.address?.state || 
                 'Unknown';
    const country = data.address?.country || 'Unknown';
    
    return { city, country };
  } catch (error) {
    console.error('❌ Ошибка Nominatim:', error.message);
    // Возвращаем заглушку если API недоступен
    return { city: 'Unknown', country: 'Unknown' };
  }
}

// ✅ Простая защита от DDOS
const requestCounts = new Map();
const RATE_LIMIT = 100; // максимум запросов
const MAX_USERS_IN_MEMORY = 10000; // Максимум пользователей в памяти (защита от memory leak)
const RATE_WINDOW = 60000; // за 1 минуту

function checkRateLimit(userId) {
    // Защита от memory leak: очищаем половину старых записей при превышении лимита
  if (requestCounts.size > MAX_USERS_IN_MEMORY) {
    const sortedEntries = Array.from(requestCounts.entries())
      .sort((a, b) => a[1][0] - b[1][0]); // Сортируем по времени первого запроса
    const toDelete = Math.floor(MAX_USERS_IN_MEMORY / 2);
    for (let i = 0; i < toDelete; i++) {
      requestCounts.delete(sortedEntries[i][0]);
    }
    console.log(`⚖️ Rate limit: очищено ${toDelete} записей. Осталось: ${requestCounts.size}`);
  }

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

// Обработчики ошибок polling (критично для стабильности)
bot.on('polling_error', (error) => {
  console.error('❌ Polling error:', error.code, error.message);
  // Не падаем, просто логируем
});

bot.on('error', (error) => {
  console.error('❌ Bot error:', error.message);
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
    kk: `🌙 *Ауыз бекітетін уақыт жақындап келеді*

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
    kk: `🌆 *Ауыз ашатын уақыт жақындап келеді*

Ауыз ашқанда айтылатын дұға:

اللَّهُمَّ لَكَ صُمْتُ وَ بِكَ آمَنْتُ وَ عَلَيْكَ تَوَكَّلْتُ وَ عَلَى رِزْقِكَ أَفْطَرْتُ

*Оқылуы:* «Аллаһумма ләкә сумту уә бикә әәмәнту уә 'аләйкә тәуәккәлту уә 'ала ризқикә әфтарту»

*Мағынасы:* «Алла Тағалам! Сенің ризалығың үшін ораза ұстадым. Саған иман етіп, саған тәуекел жасадым. Сенің берген ризығыңмен аузымды аштым»

Оразаңыз қабыл болсын! 🤲

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

// ✅ Функция отправки персонализированных уведомлений (с timezone каждого пользователя)
async function sendPersonalizedRamadanReminder(type) {
  try {
    const db = getDB();
    const users = db.collection('users');
    
    // Находим пользователей с временами намазов
    const activeUsers = await users.find({
      'prayerTimes.fajr': { $exists: true },
      paymentStatus: { $in: ['paid', 'demo'] },
      'notificationSettings.ramadanReminders': { $ne: false }
    }).toArray();
    
    if (activeUsers.length === 0) return;
    
    let sentCount = 0;
    let checkedCount = 0;
    
    for (const user of activeUsers) {
      try {
        const prayerTimes = user.prayerTimes;
        const minutesBefore = 30; // За 30 минут до намаза
        const lang = user.language || 'kk';
        
        // ✅ КЛЮЧЕВОЕ ИЗМЕНЕНИЕ: Используем timezone пользователя
        const userTimezone = user.location?.timezone || 'Asia/Almaty';
        const now = new Date();
        
        // Получаем ЛОКАЛЬНОЕ время пользователя
        const userLocalTime = new Date(now.toLocaleString('en-US', { timeZone: userTimezone }));
        const currentHour = userLocalTime.getHours();
        const currentMinute = userLocalTime.getMinutes();
        
        checkedCount++;
        
        let shouldSend = false;
        let prayerTime = '';
        
        // Проверяем сухур (за 30 минут до Fajr)
        if (type === 'suhur' && prayerTimes.fajr) {
          const reminderTime = calculateReminderTime(prayerTimes.fajr, minutesBefore);
          
          if (reminderTime.hour === currentHour && reminderTime.minute === currentMinute) {
            shouldSend = true;
            prayerTime = prayerTimes.fajr;
          }
        }
        
        // Проверяем ифтар (за 30 минут до Maghrib)
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
          
          console.log(`📨 ${type} → User ${user.userId} (${userTimezone}, ${currentHour}:${currentMinute.toString().padStart(2, '0')})`);
          
          sentCount++;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error(`❌ Ошибка отправки ${user.userId}:`, error.message);
      }
    }
    
    if (sentCount > 0) {
      console.log(`✅ ${type === 'suhur' ? '🌙 Сухур' : '🌆 Ифтар'} уведомления: ${sentCount}/${checkedCount} пользователей`);
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

// ✅ Обновляем времена намазов каждую ночь в 00:00 UTC
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

// 📊 Напоминание отметить прогресс (персонализированное по timezone каждого пользователя)
// Проверка каждый час, отправка каждому в его локальное 20:00
schedule.scheduleJob('0 * * * *', async () => {  // Каждый час
  try {
    const db = getDB();
    const users = db.collection('users');
    
    const today = new Date().toISOString().split('T')[0];
    
    // Пользователи с оплаченным доступом
    const activeUsers = await users.find({
      paymentStatus: { $in: ['paid', 'demo'] },
      'notificationSettings.ramadanReminders': { $ne: false },
      'location.timezone': { $exists: true }
    }).toArray();
    
    let sentCount = 0;
    
    for (const user of activeUsers) {
      try {
        // Получаем локальное время пользователя
        const userTimezone = user.location?.timezone || 'Asia/Almaty';
        const now = new Date();
        const userLocalTime = new Date(now.toLocaleString('en-US', { timeZone: userTimezone }));
        const currentHour = userLocalTime.getHours();
        
        // Отправляем в 20:00 по местному времени пользователя
        if (currentHour === 20) {
          // Проверяем - отмечал ли прогресс сегодня
          const hasProgressToday = user.lastActiveDate === today;
          
          if (!hasProgressToday) {
            const message = user.language === 'kk'
              ? `📲 *Бүгін әлі ештеңе белгіленбеді!*\n\nПрогрессіңізді белгілеуді ұмытпаңыз! 🌙\n\nӘр белгі — бұл сіздің рухани дамуыңызға қадам! 💪\n\n👇 Қазір белгілеңіз!`
              : `📲 *Сегодня еще ничего не отмечено!*\n\nНе забудьте отметить свой прогресс! 🌙\n\nКаждая отметка — это шаг к духовности! 💪\n\n👇 Отметьте сейчас!`;
            
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
            
            console.log(`📊 Напоминание → User ${user.userId} (${userTimezone}, ${currentHour}:00)`);
            
            sentCount++;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      } catch (error) {
        console.error(`❌ Напоминание ${user.userId}:`, error.message);
      }
    }
    
    if (sentCount > 0) {
      console.log(`✅ Напоминания о прогрессе: ${sentCount} пользователей`);
    }
  } catch (error) {
    console.error('❌ Ошибка напоминаний:', error);
  }
});

console.log('✅ Напоминание о прогрессе настроено (20:00)\n');
console.log('✅ Автообновление времен настроено (00:00)\n');

// 🔔 Проверка истекающих подписок (каждый день в 10:00 UTC)
schedule.scheduleJob('0 10 * * *', async () => {
  console.log('🔔 Проверка истекающих подписок...');
  
  try {
    const db = getDB();
    const users = db.collection('users');
    const now = new Date();
    
    // ===== ПОДПИСКИ, ИСТЕКАЮЩИЕ ЧЕРЕЗ 3 ДНЯ =====
    const in3Days = new Date(now);
    in3Days.setDate(in3Days.getDate() + 3);
    const in3DaysPlus1 = new Date(in3Days);
    in3DaysPlus1.setHours(23, 59, 59, 999);
    
    const expiring3Days = await users.find({
      paymentStatus: 'paid',
      subscriptionExpiresAt: { 
        $gte: in3Days, 
        $lte: in3DaysPlus1
      },
      subscriptionNotified3Days: { $ne: true }
    }).toArray();
    
    for (const user of expiring3Days) {
      try {
        const expiresAt = new Date(user.subscriptionExpiresAt);
        const daysLeft = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
        
        await bot.sendMessage(
          user.userId,
          `⏰ *Жазылым мерзімі аяқталуда*\n\n` +
          `Сіздің жазылымыңыз *${daysLeft} күннен* кейін аяқталады.\n\n` +
          `📅 Аяқталу күні: ${expiresAt.toLocaleDateString('kk-KZ')}\n\n` +
          `💡 Жазылымды жаңарту үшін төмендегі батырманы басыңыз:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '🔄 Жазылымды жаңарту', callback_data: 'renew_subscription' }
              ]]
            }
          }
        );
        
        await users.updateOne(
          { userId: user.userId },
          { $set: { subscriptionNotified3Days: true } }
        );
        
        console.log(`📨 3-дневное уведомление → userId ${user.userId}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`❌ Ошибка уведомления userId ${user.userId}:`, error.message);
      }
    }
    
    // ===== ПОДПИСКИ, ИСТЕКАЮЩИЕ ЧЕРЕЗ 1 ДЕНЬ =====
    const in1Day = new Date(now);
    in1Day.setDate(in1Day.getDate() + 1);
    const in1DayPlus1 = new Date(in1Day);
    in1DayPlus1.setHours(23, 59, 59, 999);
    
    const expiring1Day = await users.find({
      paymentStatus: 'paid',
      subscriptionExpiresAt: { 
        $gte: in1Day, 
        $lte: in1DayPlus1
      },
      subscriptionNotified1Day: { $ne: true }
    }).toArray();
    
    for (const user of expiring1Day) {
      try {
        const expiresAt = new Date(user.subscriptionExpiresAt);
        const hoursLeft = Math.ceil((expiresAt - now) / (1000 * 60 * 60));
        
        await bot.sendMessage(
          user.userId,
          `⚠️ *Жазылым ертең аяқталады!*\n\n` +
          `Сіздің жазылымыңыз *${hoursLeft} сағаттан* кейін аяқталады.\n\n` +
          `📅 Аяқталу уақыты: ${expiresAt.toLocaleString('kk-KZ')}\n\n` +
          `⚡ Қолжетімділікті жоғалтпау үшін жаңартыңыз:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '🔄 Жазылымды жаңарту', callback_data: 'renew_subscription' }
              ]]
            }
          }
        );
        
        await users.updateOne(
          { userId: user.userId },
          { $set: { subscriptionNotified1Day: true } }
        );
        
        console.log(`📨 1-дневное уведомление → userId ${user.userId}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`❌ Ошибка уведомления userId ${user.userId}:`, error.message);
      }
    }
    
    // ===== ИСТЕКШИЕ ПОДПИСКИ (закрываем доступ) =====
    const expired = await users.find({
      paymentStatus: 'paid',
      subscriptionExpiresAt: { $lt: now }
    }).toArray();
    
    for (const user of expired) {
      try {
        // Закрываем доступ
        await users.updateOne(
          { userId: user.userId },
          { 
            $set: { 
              paymentStatus: 'subscription_expired',
              accessType: null,
              updatedAt: new Date()
            } 
          }
        );
        
        // Уведомляем пользователя
        await bot.sendMessage(
          user.userId,
          `❌ *Жазылым мерзімі аяқталды*\n\n` +
          `Сіздің 90 күндік жазылымыңыз аяқталды.\n\n` +
          `📅 Аяқталған күн: ${new Date(user.subscriptionExpiresAt).toLocaleDateString('kk-KZ')}\n\n` +
          `🔄 Қолжетімділікті жалғастыру үшін жаңартыңыз:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '🔄 Жазылымды жаңарту', callback_data: 'renew_subscription' }
              ]]
            }
          }
        );
        
        console.log(`❌ Подписка истекла → userId ${user.userId}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`❌ Ошибка закрытия доступа userId ${user.userId}:`, error.message);
      }
    }
    
    console.log(`✅ Проверка завершена: ${expiring3Days.length} за 3 дня, ${expiring1Day.length} за 1 день, ${expired.length} истекло`);
    
  } catch (error) {
    console.error('❌ Ошибка проверки подписок:', error);
  }
});

console.log('✅ Система проверки подписок настроена (10:00 UTC)\n');

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

  // ⚙️ НАСТРОЙКИ - Смена города (ТОЛЬКО через геолокацию)
  if (data === 'change_city') {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, 
      '📍 *Жаңа геолокацияны жіберіңіз*\n\n' +
      'Дәл уақыттарды анықтау үшін геолокациямен бөлісіңіз.',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [
            [{ text: '📍 Геолокацияны жіберу', request_location: true }],
            ['❌ Болдырмау']
          ],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
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
  if (data === 'havereceipt') {
    console.log('🔵 have_receipt START | userId:', userId);
    
    try {
      console.log('🔵 Вызываю answerCallbackQuery...');
      await bot.answerCallbackQuery(query.id);
      console.log('✅ answerCallbackQuery выполнен');
      
      console.log('🔵 Отправляю сообщение...');
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
      console.log('✅ Сообщение отправлено');

      console.log('🔵 Устанавливаю state...');
      setState(userId, 'WAITING_RECEIPT');
      console.log('✅ State установлен');
      
      console.log('✅ have_receipt ЗАВЕРШЁН | userId:', userId);
    } catch (error) {
      console.error('❌ ОШИБКА have_receipt:', error.message, error.stack);
      try {
        await bot.answerCallbackQuery(query.id, { 
          text: '⚠️ Қате орын алды. Қайталап көріңіз.',
          show_alert: true 
        });
      } catch (e) {
        console.error('❌ Не удалось отправить alert:', e.message);
      }
    }
    return;
  }

  // ==========================================
  // Обработка кнопки "Промокод енгізу" из Paywall
  // ==========================================
  if (data === 'enter_promo_code') {
    await bot.answerCallbackQuery(query.id);
    
    await bot.sendMessage(
      chatId,
      `🎁 *Промокод енгізу*\n\n` +
      `Достарыңыздың промокодын жазыңыз.\n` +
      `(6 символ, мысалы: ABC123)\n\n` +
      `Промокодпен -500₸ жеңілдік аласыз! 🎉`,
      { 
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [['❌ Артқа қайту']],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
    
    setState(userId, 'ENTERING_PROMO_FROM_PAYWALL');
    return;
  }

  // ==========================================
  // Обработка кнопки "Промокод енгізу" из Paywall
  // ==========================================
  if (data === 'enter_promo_code') {
    // ... существующий код
    return;
  }

  // ==========================================
  // Обработка кнопки "Жазылымды жаңарту"
  // ==========================================
  if (data === 'renew_subscription') {
    await bot.answerCallbackQuery(query.id);
    
    const user = await getUserById(userId);
    
    if (!user) {
      await bot.sendMessage(chatId, '❌ Пайдаланушы табылмады. /start басыңыз');
      return;
    }
    
    // Определяем цену (если был промокод/реферал - та же цена)
    const price = (user.hasDiscount || user.referredBy || user.usedPromoCode) ? 1990 : 2490;
    const hasDiscount = !!(user.hasDiscount || user.referredBy || user.usedPromoCode);
    
    await bot.sendMessage(
      chatId,
      `🔄 *Жазылымды жаңарту*\n\n` +
      `Төлем жасағаннан кейін жазылым тағы 90 күнге жаңартылады.\n\n` +
      `Бағасы: *${price}₸*`,
      { parse_mode: 'Markdown' }
    );
    
    await showPayment(chatId, userId, price, hasDiscount);
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

      // Начисляем дополнительный бонус за оплату реферала
      const user = await getUserById(targetUserId);
      if (user.referredBy) {
        const inviter = await getUserByPromoCode(user.referredBy);
        if (inviter) {
          // ✅ +400 XP за оплату (дополнительно к 100 XP при регистрации)
          await addUserXP(inviter.userId, 400, `Реферал: ${user.name || user.username || targetUserId} купил доступ`);
          
          console.log(`💰 Реферал оплатил подписку: ${user.referredBy} → userId ${targetUserId}`);
          
          try {
            await bot.sendMessage(
              inviter.userId,
              `🎁 *+400 XP!*\n\n` +
              `Сіздің досыңыз *${user.name || user.username || 'қолданушы'}* төлем жасады!\n\n` +
              `💰 Сіз барлығы алдыңыз: 500 XP (100 + 400)`,
              { parse_mode: 'Markdown' }
            );
          } catch (e) {
            console.error('❌ Ошибка уведомления рефереру:', e.message);
          }
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
        `Қайтадан көріңіз немесе қолдау қызметіне жазыңыз: @ImanTapSupport` // Добавляем контакт поддержки
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
    `ImanTap-қа қош келдіңіз! Жақсы амалдарды жоспарлауға арналған жеке көмекшіңіз.\n\n` +
    `Барлығын 30 секундта баптаймыз! 🚀`,
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
    `📍 *2/3-қадам: Нақты геолокация*\n\n` +
    `Намаз уақыттарын дәл анықтау үшін геолокацияңызбен бөлісіңіз.\n\n` +
    `⚠️ *Маңызды:* Дәл уақыттар үшін геолокация міндетті!`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          [{ text: '📍 Геолокацияны жіберу', request_location: true }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
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
  try {
    const kaspiLink = process.env.KASPI_LINK || 'https://pay.kaspi.kz/pay/ygtke7vw';
    const user = await getUserById(userId);

    // ✅ НАЧИСЛЯЕМ РЕФЕРАЛЬНЫЙ БОНУС ПОСЛЕ ЗАВЕРШЕНИЯ ОНБОРДИНГА (ОДИН РАЗ)
    if (user.referredBy && !user.referralBonusGiven) {
      const inviter = await getUserByPromoCode(user.referredBy);
      if (inviter) {
        // Увеличиваем счётчик рефералов
        await incrementReferralCount(user.referredBy);
        
        // Начисляем +100 XP обоим
        await addUserXP(userId, 100, 'Регистрация по реферальной ссылке');
        await addUserXP(inviter.userId, 100, `Реферал: ${user.name || user.username || 'Жаңа қолданушы'} зарегистрировался`);
        
        // Получаем обновлённые данные рефера (после incrementReferralCount)
        const updatedInviter = await getUserById(inviter.userId);
        
        // Отправляем уведомление рефереру
        try {
          await bot.sendMessage(
            inviter.userId,
            `🎉 *Жаңа реферал!*\n\n` +
            `👤 *${user.name || user.username || 'Жаңа қолданушы'}* сіздің промокодыңыз бойынша тіркелді!\n` +
            `🎯 Сіз алдыңыз: +100 XP\n\n` +
            `Барлық рефералдар: ${updatedInviter.invitedCount} 🔥`,
            { parse_mode: 'Markdown' }
          );
          console.log(`🎉 Реферальный бонус начислен: ${user.referredBy} → userId ${userId}`);
        } catch (e) {
          console.error('❌ Ошибка отправки уведомления рефереру:', e.message);
        }
        
        // Отмечаем что бонус уже начислен
        await updateUserOnboarding(userId, {
          referralBonusGiven: true
        });
      }
    }

    let messageText;
    let inlineKeyboard;

    // 1️⃣ Реферальная ссылка
    if (user.referredBy && hasDiscount) {
      messageText = `💳 Imantap Premium-ға қолжетімділік

🎉 Сізді <b>${user.referredBy}</b> сілтемесі бойынша шақырды!

✅ Сізге -500₸ жеңілдік берілді:
<s>${formatPrice(2490)}₸</s> → <b>${formatPrice(price)}₸</b> 🎁

📋 Не қамтылған:
✓ Рамазанның 30 күніне арналған трекер
✓ Алланың 99 есімі
✓ Мақсаттар прогресі
✓ Құранды пара бойынша оқу кестесі
✓ Турнир және XP жүйесі
✓ Топпен жұмыс

Kaspi арқылы төлем жасап, чекті осында жіберіңіз.`;
      inlineKeyboard = [
        [{ text: '💳 Kaspi арқылы төлем', url: kaspiLink }],
        [{ text: '📄 Менде чек бар', callback_data: 'havereceipt' }]
      ];
    }
    // 2️⃣ Промокод
    else if (user.usedPromoCode && hasDiscount) {
      messageText = `💳 Imantap Premium-ға қолжетімділік

🎁 Промокод қолданылды: <b>${user.usedPromoCode}</b>

✅ Сізге -500₸ жеңілдік берілді:
<s>${formatPrice(2490)}₸</s> → <b>${formatPrice(price)}₸</b> 🎁

📋 Не қамтылған:
✓ Рамазанның 30 күніне арналған трекер
✓ Алланың 99 есімі
✓ Мақсаттар прогресі
✓ Құранды пара бойынша оқу кестесі
✓ Турнир және XP жүйесі
✓ Топпен жұмыс

Kaspi арқылы төлем жасап, чекті осында жіберіңіз.`;
      inlineKeyboard = [
        [{ text: '💳 Kaspi арқылы төлем', url: kaspiLink }],
        [{ text: '📄 Менде чек бар', callback_data: 'havereceipt' }]
      ];
    }
    // 3️⃣ Без скидки
    else {
      messageText = `💳 Imantap Premium-ға қолжетімділік

💰 Бағасы: <b>${formatPrice(price)}₸</b>

📋 Не қамтылған:
✓ Рамазанның 30 күніне арналған трекер
✓ Алланың 99 есімі
✓ Мақсаттар прогресі
✓ Құранды пара бойынша оқу кестесі
✓ Турнир және XP жүйесі
✓ Топпен жұмыс

Kaspi арқылы төлем жасап, чекті осында жіберіңіз.`;
      inlineKeyboard = [
        [{ text: '💳 Kaspi арқылы төлем', url: kaspiLink }],
        [{ text: '🎁 Промокод енгізу', callback_data: 'enterpromocode' }],
        [{ text: '📄 Менде чек бар', callback_data: 'havereceipt' }]
      ];
    }

    await bot.sendMessage(chatId, messageText, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard },
      remove_keyboard: true
    });

    await updateUserOnboarding(userId, {
      paidAmount: price,
      hasDiscount: hasDiscount,
      paymentStatus: 'unpaid'
    });

    setState(userId, 'WAITING_RECEIPT');
  } catch (error) {
    console.error('showPayment:', error);
    await bot.sendMessage(chatId, '❌ Қате орын алды. Қайта көріңіз.');
  }
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
  
  if (state === 'WAITING_LOCATION' || state === 'CHANGING_CITY') {
    const { latitude, longitude } = msg.location;
    
    try {
      // ✅ Определяем часовой пояс по координатам
      const timezone = geoTz.find(latitude, longitude)[0];
      
      // ✅ Определяем город и страну по координатам (Reverse Geocoding)
      await bot.sendMessage(chatId, '⏳ Анықталуда...', { parse_mode: 'Markdown' });
      
      const { city, country } = await getCityFromCoordinates(latitude, longitude);
      
      console.log(`🌍 User ${userId}: (${latitude}, ${longitude}) → ${city}, ${country} | ${timezone}`);
      
      // ✅ Нормализуем название страны перед сохранением
      const countryNormalization = {
        'Қазақстан': 'Kazakhstan',
        'Ресей': 'Russia',
        'Россия': 'Russia',
        'Түркия': 'Turkey',
        'Турция': 'Turkey',
        'Өзбекстан': 'Uzbekistan',
        'Узбекистан': 'Uzbekistan',
        'Қырғызстан': 'Kyrgyzstan',
        'Кыргызстан': 'Kyrgyzstan'
      };

      const normalizedCountry = countryNormalization[country] || country;

      await updateUserOnboarding(userId, {
        location: { 
          city, 
          country: normalizedCountry,
          latitude, 
          longitude, 
          timezone 
        }
      });
      
      // ✅ Обновляем времена намазов
      await updateUserPrayerTimes(userId);
      
      // ✅ Если это смена города - показываем результат и завершаем
      if (state === 'CHANGING_CITY') {
        const user = await getUserById(userId);
        await bot.sendMessage(chatId,
          `✅ Қала өзгертілді: *${city}, ${country}*\n\n` +
          `🌍 Уақыт белдеуі: ${timezone}\n` +
          `🌅 Таң намазы: ${user.prayerTimes?.fajr || 'анықталмады'}\n` +
          `🌆 Ақшам намазы: ${user.prayerTimes?.maghrib || 'анықталмады'}`,
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
        clearSession(userId);
        return;  // ✅ Завершаем, НЕ вызываем requestPromoCode
      }
      
      // ✅ Если это онбординг - продолжаем к промокоду
      await requestPromoCode(chatId, userId);
      
    } catch (error) {
      console.error('❌ Ошибка обработки геолокации:', error);
      await bot.sendMessage(chatId, '❌ Қате орын алды. Қайталап көріңіз.');
    }
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
      );
    } catch (error) {
      console.error('stats ошибка:', error);
      bot.sendMessage(chatId, '❌ Қате. Қайта көріңіз.');
    }
    return;
  }
  
  if (text === '🎁 Менің промокодым') {
    try {
      const user = await getUserById(userId);
      
      if (!user) {
        bot.sendMessage(chatId, '⚠️ Пайдаланушы табылмады. /start басыңыз');
        return;
      }
      
      const botUsername = 'imantap_bot';
      const referralLink = `https://t.me/${botUsername}?start=ref_${user.promoCode}`;
      
      // Экранируем подчёркивания для Markdown
      const escapedLink = referralLink.replace(/_/g, '\\_');
      
      const message = `🎁 *Сіздің промокодыңыз:*\n\n` +
        `📋 \`${user.promoCode}\`\n\n` +
        `👥 Шақырылғандар: ${user.invitedCount}\n\n` +
        `${escapedLink}\n\n` +
        `Достарыңызды шақырыңыз! 🚀`;
      
      bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('mycode ошибка:', error);
      bot.sendMessage(chatId, '❌ Қате. Қайта көріңіз.');
    }
    return;
  }

  // 📍 СМЕНА ГОРОДА (только через геолокацию)
  if (state === 'CHANGING_CITY') {
    if (text === '❌ Болдырмау') {
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
    
    // Если пользователь написал текст вместо геолокации - просим геолокацию
    await bot.sendMessage(chatId, 
      '📍 *Геолокацияны жіберу керек!*\n\n' +
      'Дәл уақыттарды анықтау үшін геолокациямен бөлісіңіз.\n\n' +
      'Төмендегі батырманы басыңыз:',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [
            [{ text: '📍 Геолокацияны жіберу', request_location: true }],
            ['❌ Болдырмау']
          ],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
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
      `ImanTap Premium бағасы:\n\n` +
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

    // ✅ ПРОВЕРКА: уже использовал промокод?
    const user = await getUserById(userId);
    if (user.usedPromoCode || user.referredBy) {
      await bot.sendMessage(
        chatId,
        `❌ *Промокод қолдану мүмкін емес*\n\n` +
        `Сіз бұрын промокод қолдандыңыз: *${user.usedPromoCode || user.referredBy}*\n\n` +
        `Бір қолданушы тек бір промокод қолдана алады.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [['❌ Артқа қайту']],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        }
      );
      return;
    }

    const check = await checkPromoCode(promoCode, userId);
    
    if (check.valid) {
      await updateUserOnboarding(userId, {
        usedPromoCode: promoCode,
        hasDiscount: true
      });
      
      await markPromoCodeAsUsed(promoCode, userId);
      
      await bot.sendMessage(
        chatId,
        `✅ Промокод қабылданды!

      🎉 Сізге -500₸ жеңілдік берілді:
      <s>${formatPrice(2490)}₸</s> → <b>${formatPrice(1990)}₸</b> 🎁`,
        { parse_mode: 'HTML' }
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

    // ✅ ПРОВЕРКА: уже использовал промокод?
    const user = await getUserById(userId);
    if (user.usedPromoCode || user.referredBy) {
      await bot.sendMessage(
        chatId,
        `❌ *Промокод қолдану мүмкін емес*\n\n` +
        `Сіз бұрын промокод қолдандыңыз: *${user.usedPromoCode || user.referredBy}*\n\n` +
        `Бір қолданушы тек бір промокод қолдана алады.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [['❌ Артқа қайту']],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        }
      );
      return;
    }

    const check = await checkPromoCode(promoCode, userId);
    
    if (check.valid) {
      await updateUserOnboarding(userId, {
        usedPromoCode: promoCode,
        hasDiscount: true
      });
      
      await markPromoCodeAsUsed(promoCode, userId);
      
      await bot.sendMessage(
        chatId,
        `✅ Промокод қабылданды!

      🎉 Сізге -500₸ жеңілдік берілді:
      <s>${formatPrice(2490)}₸</s> → <b>${formatPrice(1990)}₸</b> 🎁`,
        { parse_mode: 'HTML' }
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

  // 🎟️ ВВОД ПРОМОКОДА ИЗ PAYWALL (инлайн кнопка)
  if (state === 'ENTERING_PROMO_FROM_PAYWALL') {
    if (text === '❌ Артқа қайту') {
      // Возвращаемся к экрану оплаты
      const user = await getUserById(userId);
      const price = user?.hasDiscount ? 1990 : 2490;
      await showPayment(chatId, userId, price, user?.hasDiscount || false);
      clearState(userId);
      return;
    }
    
    const promoCode = text.toUpperCase().trim();
    
    // Проверяем длину
    if (promoCode.length !== 6) {
      await bot.sendMessage(
        chatId, 
        '⚠️ Промокод 6 символдан тұруы керек!\n\nҚайта енгізіңіз:',
        {
          reply_markup: {
            keyboard: [['❌ Артқа қайту']],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        }
      );
      return;
    }
    
    const user = await getUserById(userId);

    // ✅ ПРОВЕРКА: уже использовал промокод?
    if (user.usedPromoCode || user.referredBy) {
      await bot.sendMessage(
        chatId,
        `❌ *Промокод қолдану мүмкін емес*\n\n` +
        `Сіз бұрын промокод қолдандыңыз: *${user.usedPromoCode || user.referredBy}*\n\n` +
        `Бір қолданушы тек бір промокод қолдана алады.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [['❌ Артқа қайту']],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        }
      );
      return;
    }
    
    // Проверяем что это не свой промокод
    if (promoCode === user.promoCode) {
      await bot.sendMessage(
        chatId,
        '❌ Өз промокодыңызды пайдалануға болмайды!\n\nҚайта енгізіңіз:',
        {
          reply_markup: {
            keyboard: [['❌ Артқа қайту']],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        }
      );
      return;
    }
    
    // Проверяем промокод
    const check = await checkPromoCode(promoCode, userId);
    
    if (check.valid) {
      const newPrice = 1990;
      
      // ✅ ПРИМЕНЯЕМ ПРОМОКОД
      await updateUserOnboarding(userId, {
        usedPromoCode: promoCode,
        hasDiscount: true,
        paidAmount: newPrice
      });
      
      await markPromoCodeAsUsed(promoCode, userId);
      
      // Начисляем XP обоим
      await addUserXP(userId, 100, 'Использован промокод');
      await addUserXP(check.owner.userId, 100, `Промокод использован пользователем ${userId}`);
      
      await bot.sendMessage(
        chatId,
        `✅ Промокод қабылданды!

      🎉 Қосымша бонус!

      ✅ <s>${formatPrice(2490)}₸</s> → <b>${formatPrice(newPrice)}₸</b> 🎁

      🎁 Сіз бен промокод иесі 100 XP аласыз!
      ✨ Сіз: +100 XP
      ✨ ${check.owner.name}: +100 XP`,
        { parse_mode: 'HTML' }
      );

      
      // Показываем оплату со скидкой
      await showPayment(chatId, userId, newPrice, true);
      
      // Уведомляем владельца промокода
      try {
        await bot.sendMessage(
          check.owner.userId,
          `🎉 *Промокод пайдаланылды!*\n\n` +
          `Сіздің *${promoCode}* промокодыңыз қолданылды!\n` +
          `🎯 +100 XP алдыңыз! 🔥`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        console.log('⚠️ Не удалось уведомить владельца промокода');
      }
      
      clearState(userId);
      
    } else {
      // Промокод невалидный
      let errorMsg = '❌ *Промокод қате*\n\n';
      
      if (check.reason === 'not_found') {
        errorMsg += 'Бұл промокод табылмады.';
      } else if (check.reason === 'already_used') {
        errorMsg += 'Бұл промокод қолданылған.';
      } else if (check.reason === 'own_code') {
        errorMsg += 'Өз промокодыңызды қолдануға болмайды.';
      } else if (check.reason === 'owner_not_paid') {
        errorMsg += 'Промокод иесі төлем жасамаған.';
      }
      
      errorMsg += '\n\nҚайта енгізіңіз немесе артқа қайтыңыз:';
      
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

    // Определяем реферала
    let referralInfo = '—';
    if (user.referredBy) {
      referralInfo = `${user.referredBy}`;
    } else if (user.usedPromoCode) {
      // Если ввёл промокод вручную, находим владельца
      const promoOwner = await getUserByPromoCode(user.usedPromoCode);
      if (promoOwner) {
        referralInfo = `${user.usedPromoCode} (от @${promoOwner.username || promoOwner.userId})`;
      } else {
        referralInfo = `${user.usedPromoCode}`;
      }
    }

    const discountText = user.hasDiscount 
      ? `<s>${formatPrice(2490)}</s> → <b>${formatPrice(user.paidAmount)}</b> ✅ Скидка!` 
      : `<b>${formatPrice(user.paidAmount)}</b>`;

    const caption = 
      `🔔 <b>Новый платёж на проверке!</b>\n\n` +
      `👤 User ID: <code>${userId}</code>\n` +
      `📱 Username: ${user.username ? '@' + user.username : '—'}\n` +
      `📞 Телефон: ${user.phoneNumber || '—'}\n` +
      `📍 Город: ${user.location?.city || '—'}\n` +
      `💰 Сумма: ${discountText}\n` +
      `🎟️ Промокод: ${user.usedPromoCode || '—'}\n` +
      `👥 Реферал: ${referralInfo}\n` +
      `📅 ${new Date().toLocaleString('ru-RU')}`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Одобрить', callback_data: `approve_${userId}` },
          { text: '❌ Отклонить', callback_data: `reject_${userId}` }
        ]
      ]
    };

    for (const adminId of adminIds) {
      try {
        if (fileType === 'photo') {
          await bot.sendPhoto(adminId, fileId, { 
            caption, 
            parse_mode: 'HTML', 
            reply_markup: keyboard 
          });
        } else {
          await bot.sendDocument(adminId, fileId, { 
            caption, 
            parse_mode: 'HTML', 
            reply_markup: keyboard 
          });
        }
        console.log(`✅ Уведомление отправлено админу ${adminId}`);
      } catch (error) {
        console.error(`❌ Не удалось отправить админу ${adminId}:`, error.message);
      }
    }
  } catch (error) {
    console.error('❌ Ошибка в notifyAdminsNewPayment:', error);
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
        `Вы администратор ImanTap.\n\n` +
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

    // 🔥 ИСТЕКШАЯ ПОДПИСКА - предлагаем продлить
    if (user.paymentStatus === 'subscription_expired') {
      bot.sendMessage(
        chatId,
        `❌ Сәлем, ${from.firstname}!\n\n` +
        `Сіздің жазылымыңыз аяқталды.\n\n` +
        `📅 Аяқталған күн: ${new Date(user.subscriptionExpiresAt).toLocaleDateString('kk-KZ')}\n\n` +
        `🔄 Жаңарту үшін төмендегі батырманы басыңыз:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🔄 Жазылымды жаңарту', callback_data: 'renew_subscription' }
            ]]
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
        `ImanTap-қа қайта қош келдіңіз!\n\n` +
        `Трекерді ашу үшін төмендегі батырманы басыңыз:`,
        {
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
        // Сохраняем реферал и применяем скидку
        await updateUserOnboarding(userId, {
          referredBy: referralCode,
          hasDiscount: true
        });
        
        // Реферальный бонус будет начислен ПОСЛЕ завершения онбординга
        console.log(`🎯 Реферал начал онбординг: userId ${userId} → промокод ${referralCode}`);
        
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

    // 🔥 ПАРАМЕТР PAYMENT - открыть экран оплаты из Mini App
    if (param === 'payment') {
      // Если уже оплатил - говорим об этом
      if (user.paymentStatus === 'paid') {
        await bot.sendMessage(
          chatId,
          `✅ Сізде қазірдің өзінде Premium бар!\n\n` +
          `Mini App-ты ашыңыз:`,
          {
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
        return;
      }
      
      // Определяем цену
      const price = (user.hasDiscount || user.referredBy || user.usedPromoCode) ? 1990 : 2490;
      const hasDiscount = !!(user.hasDiscount || user.referredBy || user.usedPromoCode);
      
      // Показываем экран оплаты
      await showPayment(chatId, userId, price, hasDiscount);
      return;
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
          `⚠️ Вы удалены из списка менеджеров ImanTap.`
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

    // ✅ API: /api/check-access (для фронтенда miniapp)
    if (url.pathname === '/api/check-access') {
      const userId = parseInt(url.searchParams.get('userId'));
      
      if (!userId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'userId required' }));
        return;
      }
      
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

      // Читаем body запроса
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      
      req.on('end', async () => {
        try {
          const progressData = JSON.parse(body);
          
          // Обновляем данные пользователя
          const success = await updateUserProgress(userId, progressData);
          
          if (success) {
            console.log(`✅ Прогресс синхронизирован для пользователя ${userId}`);
            
            // Возвращаем обновлённые данные
            const updatedData = await getUserFullData(userId);
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true, data: updatedData }));
          } else {
            console.error(`❌ Не удалось обновить данные для ${userId}`);
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: 'Failed to update progress' }));
          }
        } catch (parseError) {
          console.error('❌ Ошибка парсинга JSON:', parseError);
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

    // API: Получить список стран
    if (url.pathname === '/api/countries') {
      try {
        const countries = await getCountries();
        res.statusCode = 200;
        res.end(JSON.stringify({ 
          success: true, 
          data: countries 
        }));
        return;
      } catch (error) {
        console.error('❌ API Error /countries:', error);
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
        return;
      }
    }

    // API: Получить список городов в стране
    if (url.pathname.startsWith('/api/cities/')) {
      try {
        const country = decodeURIComponent(url.pathname.split('/')[3]);
        
        if (!country) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Country required' }));
          return;
        }
        
        const cities = await getCities(country);
        res.statusCode = 200;
        res.end(JSON.stringify({ 
          success: true, 
          data: cities 
        }));
        return;
      } catch (error) {
        console.error('❌ API Error /cities:', error);
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

    // API: Создать круг
    if (url.pathname === '/api/circles/create' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      
      req.on('end', async () => {
        try {
          const { userId, name, description } = JSON.parse(body);
          
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
          const { circleId, inviterId, targetUsername } = JSON.parse(body);
          
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
          const { circleId, userId } = JSON.parse(body);
          
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
          const { circleId, userId } = JSON.parse(body);
          
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
          const { circleId, ownerId, targetUserId } = JSON.parse(body);
          
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
          const { circleId, ownerId } = JSON.parse(body);
          
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
          const { circleId, userId } = JSON.parse(body);
          
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
          const { inviteCode, userId } = JSON.parse(body);
          
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
server.listen(PORT, () => {
  console.log(`✅ HTTP API Server running on port ${PORT}`);
  console.log(`✅ Bot started successfully`);
  console.log(`✅ Mini App URL: ${MINI_APP_URL}`);
});

console.log('🚀 ImanTap Bot запускается...');
