import schedule from 'node-schedule';
import { getDB } from './db.js';
import {
  updateUserPrayerTimes,
  resolveSafeTimezone,
  getLocalTimeParts,
} from './prayerTimesService.js';

/**
 * Проверка, что пользователь заблокировал бота или чат недоступен (403 / deactivated)
 */
export function isTelegramBlockedError(error) {
  const code = error?.response?.body?.error_code ?? error?.response?.statusCode;
  if (code === 403) return true;
  if (code === 400) {
    const desc = String(error?.response?.body?.description || error?.message || '');
    if (/chat not found|user is deactivated/i.test(desc)) return true;
  }
  return false;
}

/**
 * Нужно ли обновлять времена намазов пользователя в данный момент (по его timezone)
 * Обновляем в 00:30 (и в 01:30 как self-healing при рестарте), но не чаще раза в локальный день.
 */
export function shouldRefreshUserPrayerTimes(user, now = new Date()) {
  const hasLocation =
    (user?.location?.latitude != null && user?.location?.longitude != null) ||
    Boolean(user?.location?.city);
  if (!hasLocation) return false;

  const userTimezone = resolveSafeTimezone(user?.location?.timezone);
  const { hour, dateStr } = getLocalTimeParts(now, userTimezone);

  if (user?.prayerTimes?.date === dateStr) {
    return false;
  }

  return hour === 0 || hour === 1;
}

export function registerCoreSchedulers({
  bot,
  miniAppUrl,
  sendPersonalizedRamadanReminder,
  sendDailyContestMotivation,
}) {
  let isMinuteReminderRunning = false;
  let isPrayerUpdateRunning = false;
  let isProgressReminderRunning = false;

  // ✅ Проверка каждую минуту (с защитой от наложения тиков)
  console.log('⏰ Система персонализированных уведомлений запущена');

  schedule.scheduleJob('* * * * *', async () => {
    if (isMinuteReminderRunning) {
      console.warn('⚠️ Предыдущий тик напоминаний ещё выполняется — пропускаем');
      return;
    }
    isMinuteReminderRunning = true;
    try {
      await sendPersonalizedRamadanReminder('prayer_times');
      await sendPersonalizedRamadanReminder('suhur');
      await sendPersonalizedRamadanReminder('iftar');
    } catch (error) {
      console.error('❌ Ошибка планировщика напоминаний (сухур/ифтар):', error);
    } finally {
      isMinuteReminderRunning = false;
    }
  });

  // ✅ Обновляем времена намазов в 00:30 по локальной timezone каждого пользователя
  // (для Казахстана UTC+5 это по-прежнему 19:30 UTC = 00:30 Алматы; для других TZ — их локальные 00:30)
  schedule.scheduleJob('30 * * * *', async () => {
    if (isPrayerUpdateRunning) {
      console.warn('⚠️ Обновление времён намазов ещё выполняется — пропускаем');
      return;
    }
    isPrayerUpdateRunning = true;
    try {
      const db = getDB();
      const users = db.collection('users');
      const now = new Date();

      // ✅ Берём ВСЕХ у кого есть локация (координаты ИЛИ город)
      const allUsers = await users.find({
        $or: [
          { 'location.latitude': { $exists: true } },
          { 'location.city': { $exists: true } }
        ]
      }).toArray();

      const dueUsers = allUsers.filter(u => shouldRefreshUserPrayerTimes(u, now));
      if (dueUsers.length === 0) return;

      console.log(`🔄 Обновление времен намазов для ${dueUsers.length} пользователей (локальная ночь)...`);

      let updated = 0;

      for (let i = 0; i < dueUsers.length; i++) {
        const user = dueUsers[i];
        try {
          const result = await updateUserPrayerTimes(user.userId);
          if (result) updated++;
        } catch (err) {
          console.error(`❌ Ошибка обновления намаза для userId ${user.userId}:`, err?.message || err);
        }
        if ((i + 1) % 50 === 0) {
          console.log(`⏳ Обновлено ${i + 1}/${dueUsers.length}...`);
        }
        // Throttle: 300ms между запросами — не перегружаем Aladhan и Муфтият API
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      console.log(`✅ Намазы обновлены: ${updated}/${dueUsers.length} пользователей`);
    } catch (error) {
      console.error('❌ Ошибка обновления времён намаза:', error);
    } finally {
      isPrayerUpdateRunning = false;
    }
  });

  // 📊 Напоминание отметить прогресс (персонализированное по timezone каждого пользователя)
  // Проверка каждый час, отправка каждому в его локальное 20:00 (не более 1 раза в день)
  schedule.scheduleJob('0 * * * *', async () => {
    if (isProgressReminderRunning) {
      console.warn('⚠️ Рассылка напоминаний о прогрессе ещё выполняется — пропускаем');
      return;
    }
    isProgressReminderRunning = true;
    try {
      const db = getDB();
      const users = db.collection('users');

      // Пользователи с оплаченным доступом
      const activeUsers = await users.find({
        paymentStatus: { $in: ['paid', 'demo'] },
        'notificationSettings.ramadanReminders': { $ne: false },
        'location.timezone': { $exists: true }
      }).toArray();

      let sentCount = 0;
      const now = new Date();

      for (const user of activeUsers) {
        let claimedToday = false;
        try {
          const userTimezone = resolveSafeTimezone(user.location?.timezone);
          const { hour: currentHour, dateStr: todayForUser } = getLocalTimeParts(now, userTimezone);

          // Отправляем в 20:00 по местному времени пользователя
          if (currentHour !== 20) continue;

          // Уже отмечал прогресс сегодня или напоминание уже отправлялось сегодня
          if (user.lastActiveDate === todayForUser) continue;
          if (user.lastReminderSent?.progress === todayForUser) continue;

          // Атомарная защита от повторной отправки за этот день
          const claim = await users.updateOne(
            { userId: user.userId, 'lastReminderSent.progress': { $ne: todayForUser } },
            { $set: { 'lastReminderSent.progress': todayForUser } }
          );
          if (claim.modifiedCount === 0) continue;
          claimedToday = true;

          const message = user.language === 'kk'
            ? `📲 *Бүгін әлі ештеңе белгіленбеді!*\n\nПрогрессіңізді белгілеуді ұмытпаңыз! 🌙\n\nӘр белгі — бұл сіздің рухани дамуыңызға қадам! 💪\n\n👇 Қазір белгілеңіз!`
            : `📲 *Сегодня еще ничего не отмечено!*\n\nНе забудьте отметить свой прогресс! 🌙\n\nКаждая отметка — это шаг к духовности! 💪\n\n👇 Отметьте сейчас!`;

          await bot.sendMessage(user.userId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
              keyboard: [[{
                text: '📱 ImanTap ашу',
                web_app: { url: `${miniAppUrl}?tgWebAppStartParam=${user.userId}` }
              }]],
              resize_keyboard: true
            }
          });

          console.log(`📊 Напоминание → User ${user.userId} (${userTimezone}, ${currentHour}:00)`);

          sentCount++;
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          if (isTelegramBlockedError(error)) {
            await users.updateOne(
              { userId: user.userId },
              { $set: { 'notificationSettings.ramadanReminders': false } }
            );
            console.log(`🚫 User ${user.userId} заблокировал бота — уведомления отключены`);
          } else {
            if (claimedToday) {
              await users.updateOne(
                { userId: user.userId },
                { $unset: { 'lastReminderSent.progress': '' } }
              ).catch(() => {});
            }
            console.error(`❌ Напоминание ${user.userId}:`, error?.message || error);
          }
        }
      }

      if (sentCount > 0) {
        console.log(`✅ Напоминания о прогрессе: ${sentCount} пользователей`);
      }
    } catch (error) {
      console.error('❌ Ошибка напоминаний:', error);
    } finally {
      isProgressReminderRunning = false;
    }
  });

  console.log('✅ Напоминание о прогрессе настроено (20:00 локально)\n');
  console.log('✅ Автообновление времен настроено (00:30 по локальной timezone каждого пользователя)');

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

  // ✅ Конкурс: мотивационные уведомления 12:00 Asia/Almaty = 07:00 UTC
  schedule.scheduleJob('0 7 * * *', async () => {
    try {
      await sendDailyContestMotivation('morning');
    } catch (err) {
      console.error('❌ Ошибка утреннего уведомления конкурса:', err);
    }
  });

  // ✅ Конкурс: мотивационные уведомления 20:00 Asia/Almaty = 15:00 UTC
  schedule.scheduleJob('0 15 * * *', async () => {
    try {
      await sendDailyContestMotivation('evening');
    } catch (err) {
      console.error('❌ Ошибка вечернего уведомления конкурса:', err);
    }
  });
  console.log('⏰ Ежедневные уведомления конкурса запланированы (07:00 и 15:00 UTC)');
}
