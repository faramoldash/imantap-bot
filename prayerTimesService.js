// prayerTimesService.js
import fetch from 'node-fetch';
import { getDB } from './db.js';

/**
 * Найти ближайший город из базы Муфтията по имени города пользователя
 * Использует search-параметр чтобы не грузить все 5695 городов
 */
async function findNearestMuftyatCity(latitude, longitude, cityName = '') {
  const candidates = [];

  // Ищем по имени города если есть — так точнее
  if (cityName) {
    const res = await fetch(`https://api.muftyat.kz/cities/?search=${encodeURIComponent(cityName)}`);
    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : (Array.isArray(data) ? data : []);
    candidates.push(...results);
  }

  // Если по имени ничего — берём первую страницу (ближайший по координатам)
  if (candidates.length === 0) {
    const res = await fetch('https://api.muftyat.kz/cities/');
    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : (Array.isArray(data) ? data : []);
    candidates.push(...results);
  }

  let nearest = null;
  let minDist = Infinity;

  for (const city of candidates) {
    const dlat = parseFloat(city.lat) - latitude;
    const dlng = parseFloat(city.lng) - longitude;
    const dist = dlat * dlat + dlng * dlng;
    if (dist < minDist) {
      minDist = dist;
      nearest = city;
    }
  }

  return nearest;
}

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
 * Получить текущий год в timezone пользователя
 */
function getYearForTimezone(timezone = 'Asia/Almaty') {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone }).split('-')[0];
}

/**
 * Получить сегодняшнюю дату в формате YYYY-MM-DD для Muftyat API
 */
function getTodayISOForTimezone(timezone = 'Asia/Almaty') {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone }); // → "2026-03-26"
}

/**
 * Получить времена намазов через официальный API Муфтията Казахстана
 * Используется для пользователей из Казахстана — самый точный источник
 */
export async function getPrayerTimesByMuftyat(latitude, longitude, timezone = 'Asia/Almaty', cityName = '') {
  try {
    const year = getYearForTimezone(timezone);
    const todayStr = getTodayISOForTimezone(timezone);

    // Находим ближайший город из БД Муфтията (API требует точных координат)
    const nearestCity = await findNearestMuftyatCity(latitude, longitude, cityName);
    if (!nearestCity) return null;

    const lat = nearestCity.lat;
    const lng = nearestCity.lng;

    const url = `https://api.muftyat.kz/prayer-times/${year}/${lat}/${lng}`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.result || !Array.isArray(data.result)) return null;

    const today = data.result.find(d => d.Date === todayStr);
    if (!today) return null;

    return {
      fajr: today.fajr,
      sunrise: today.sunrise,
      dhuhr: today.dhuhr,
      asr: today.asr,
      maghrib: today.maghrib,
      isha: today.isha,
      date: todayStr,
      lastUpdated: new Date(),
      source: 'muftyat'
    };
  } catch (error) {
    console.error('❌ Ошибка получения намазов (Муфтият KZ):', error);
    return null;
  }
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
    const hasCoords = user.location?.latitude && user.location?.longitude;
    const isKazakhstan = /kazakh|казах|kz/i.test(user.location?.country || '');
    // По умолчанию ҚМДБ (muftyat), пользователь может переключить на aladhan
    const useMuftyat = isKazakhstan && user.prayerTimeSource !== 'aladhan';

    // ✅ ПРИОРИТЕТ 1: Координаты + Казахстан + ҚМДБ → Муфтият KZ (официальный источник)
    if (hasCoords && useMuftyat) {
      prayerTimes = await getPrayerTimesByMuftyat(
        user.location.latitude,
        user.location.longitude,
        userTimezone,
        user.location.city || ''
      );
      if (prayerTimes) {
        console.log(`🕌 Муфтият KZ: userId ${userId} (${userTimezone}), дата: ${prayerTimes.date}`);
      } else {
        console.warn(`⚠️ Муфтият KZ не ответил, fallback на Aladhan`);
      }
    }

    // ✅ ПРИОРИТЕТ 2: Координаты (Aladhan) — для не-KZ, при выборе Aladhan или fallback
    if (!prayerTimes && hasCoords) {
      prayerTimes = await getPrayerTimesByCoordinates(
        user.location.latitude,
        user.location.longitude,
        userTimezone
      );
      console.log(`📍 Aladhan координаты: userId ${userId} (${userTimezone}), дата: ${prayerTimes?.date}`);
    }
    // ✅ ПРИОРИТЕТ 3: Город
    if (!prayerTimes && user.location?.city) {
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