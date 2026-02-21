// prayerTimesService.js
import fetch from 'node-fetch';
import { getDB } from './db.js';

/**
 * Получить дату в нужном timezone в формате DD-MM-YYYY для Aladhan API
 * Сервер Railway = UTC. Без этого API вернёт времена для неправильного дня.
 */
function getDateForTimezone(timezone = 'Asia/Almaty') {
  const userDate = new Date().toLocaleDateString('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }); // → "21/02/2026"
  const [day, month, year] = userDate.split('/');
  return `${day}-${month}-${year}`; // → "21-02-2026" (формат Aladhan API)
}

/**
 * Получить времена намазов для города
 */
export async function getPrayerTimesByCity(city, country, timezone = 'Asia/Almaty') {
  try {
    const dateParam = getDateForTimezone(timezone);
    const url = `https://api.aladhan.com/v1/timingsByCity/${dateParam}?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&method=2`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.code === 200 && data.data) {
      const timings = data.data.timings;
      return {
        fajr: timings.Fajr,
        sunrise: timings.Sunrise,
        dhuhr: timings.Dhuhr,
        asr: timings.Asr,
        maghrib: timings.Maghrib,
        isha: timings.Isha,
        date: dateParam,
        lastUpdated: new Date()
      };
    }

    return null;
  } catch (error) {
    console.error('❌ Ошибка получения времени намазов (город):', error);
    return null;
  }
}

/**
 * Получить времена намазов по координатам (ТОЧНЕЕ!)
 */
export async function getPrayerTimesByCoordinates(latitude, longitude, timezone = 'Asia/Almaty') {
  try {
    const dateParam = getDateForTimezone(timezone);
    const url = `https://api.aladhan.com/v1/timings/${dateParam}?latitude=${latitude}&longitude=${longitude}&method=2`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.code === 200 && data.data) {
      const timings = data.data.timings;
      return {
        fajr: timings.Fajr,
        sunrise: timings.Sunrise,
        dhuhr: timings.Dhuhr,
        asr: timings.Asr,
        maghrib: timings.Maghrib,
        isha: timings.Isha,
        date: dateParam,
        lastUpdated: new Date()
      };
    }

    return null;
  } catch (error) {
    console.error('❌ Ошибка получения времени намазов (координаты):', error);
    return null;
  }
}

/**
 * Вычислить время уведомления (за N минут до намаза)
 * Чистая арифметика — НЕ зависит от timezone сервера
 */
export function calculateReminderTime(prayerTime, minutesBefore = 15) {
  const cleanTime = prayerTime.split(' ')[0]; // убираем "(BST)" если есть
  const [hours, minutes] = cleanTime.split(':').map(Number);

  let totalMinutes = hours * 60 + minutes - minutesBefore;

  // Обработка перехода через полночь (например 00:10 - 30мин = 23:40)
  totalMinutes = ((totalMinutes % 1440) + 1440) % 1440;

  return {
    hour: Math.floor(totalMinutes / 60),
    minute: totalMinutes % 60
  };
}

/**
 * Обновить времена намазов для конкретного пользователя
 */
export async function updateUserPrayerTimes(userId) {
  try {
    const db = getDB();
    const users = db.collection('users');

    const user = await users.findOne({ userId });
    if (!user) return false;

    // ✅ Берём timezone пользователя из БД
    const userTimezone = user.location?.timezone || 'Asia/Almaty';

    let prayerTimes = null;

    // ✅ ПРИОРИТЕТ 1: Координаты (самое точное!)
    if (user.location?.latitude && user.location?.longitude) {
      prayerTimes = await getPrayerTimesByCoordinates(
        user.location.latitude,
        user.location.longitude,
        userTimezone
      );
      console.log(`📍 Координаты: userId ${userId} (${userTimezone}), дата: ${prayerTimes?.date}`);
    }
    // ✅ ПРИОРИТЕТ 2: Город
    else if (user.location?.city) {
      prayerTimes = await getPrayerTimesByCity(
        user.location.city,
        user.location.country || 'Kazakhstan',
        userTimezone
      );
      console.log(`🏙️ Город ${user.location.city}: userId ${userId} (${userTimezone}), дата: ${prayerTimes?.date}`);
    }

    if (prayerTimes) {
      await users.updateOne(
        { userId },
        { $set: { prayerTimes, updatedAt: new Date() } }
      );
      console.log(`✅ Намазы обновлены: Fajr ${prayerTimes.fajr}, Maghrib ${prayerTimes.maghrib}`);
      return true;
    }

    console.warn(`⚠️ Нет локации для userId ${userId} — пропускаем`);
    return false;
  } catch (error) {
    console.error(`❌ Ошибка обновления намазов userId ${userId}:`, error);
    return false;
  }
}