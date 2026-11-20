// prayerTimesService.js
import fetch from 'node-fetch';
import { getDB } from './db.js';
import {
  findRegionalCenterByName,
  isValidCoords,
  isKazakhstanCoords,
} from './utils/cityMapping.js';

export const DEFAULT_TIMEZONE = 'Asia/Almaty';
export const DEFAULT_FETCH_TIMEOUT_MS = 8000;
export const MAX_MUFTYAT_DISTANCE_KM = 350;

const PRAYER_KEYS_FOR_NEXT = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

/**
 * Безопасно проверить IANA timezone; при невалидной строке вернуть Asia/Almaty
 */
export function resolveSafeTimezone(timezone) {
  if (typeof timezone === 'string' && timezone.trim()) {
    const candidate = timezone.trim();
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: candidate });
      return candidate;
    } catch {
      // Fallback below
    }
  }
  return DEFAULT_TIMEZONE;
}

/**
 * Получить сегодняшнюю дату в формате YYYY-MM-DD в timezone пользователя
 */
export function getTodayISOForTimezone(timezone = DEFAULT_TIMEZONE, date = new Date()) {
  const safeTz = resolveSafeTimezone(timezone);
  return date.toLocaleDateString('en-CA', { timeZone: safeTz }); // → "2026-03-26"
}

/**
 * Получить дату в нужном timezone в формате DD-MM-YYYY для Aladhan API
 * Сервер Railway = UTC. Без этого API вернёт времена для неправильного дня.
 */
export function getDateForTimezone(timezone = DEFAULT_TIMEZONE, date = new Date()) {
  const iso = getTodayISOForTimezone(timezone, date); // "YYYY-MM-DD"
  const [year, month, day] = iso.split('-');
  return `${day}-${month}-${year}`; // → "21-02-2026"
}

/**
 * Получить текущий год в timezone пользователя
 */
export function getYearForTimezone(timezone = DEFAULT_TIMEZONE, date = new Date()) {
  return getTodayISOForTimezone(timezone, date).split('-')[0];
}

/**
 * Получить локальные час/минуту/секунду/дату в timezone пользователя (без бага "24:xx")
 */
export function getLocalTimeParts(date = new Date(), timezone = DEFAULT_TIMEZONE) {
  const safeTz = resolveSafeTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: safeTz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const hourRaw = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
  const second = Number(parts.find(p => p.type === 'second')?.value ?? 0);

  return {
    hour: hourRaw % 24,
    minute,
    second,
    dateStr: getTodayISOForTimezone(safeTz, date),
    timezone: safeTz,
  };
}

/**
 * Очистить и валидировать строку времени ("05:12 (AQTT)" → "05:12")
 */
export function normalizePrayerTime(timeStr) {
  if (typeof timeStr !== 'string') return null;
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Проверить, что объект времён намазов содержит валидные 5 обязательных намазов
 */
export function isValidPrayerTimes(pt) {
  if (!pt || typeof pt !== 'object') return false;
  return PRAYER_KEYS_FOR_NEXT.every(key => normalizePrayerTime(pt[key]) !== null);
}

/**
 * Расстояние между двумя точками (Haversine, км)
 */
export function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Выполнить GET-запрос JSON с таймаутом и проверкой response.ok
 */
export async function fetchJsonWithTimeout(url, options = {}) {
  const fetchFn = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const headers = options.headers || {};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const err = new Error(`HTTP ${response.status} for ${url}`);
      err.status = response.status;
      throw err;
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Найти ближайший город из базы Муфтията по имени города и координатам
 * Использует search-параметр чтобы не грузить все 5695 городов
 */
export async function findNearestMuftyatCity(latitude, longitude, cityName = '', options = {}) {
  if (!isValidCoords(latitude, longitude)) return null;

  const numLat = Number(latitude);
  const numLon = Number(longitude);
  const maxDistanceKm = options.maxDistanceKm ?? MAX_MUFTYAT_DISTANCE_KM;
  const candidates = [];

  const searchTerms = [];
  if (typeof cityName === 'string' && cityName.trim()) {
    const trimmed = cityName.trim();
    searchTerms.push(trimmed);
    const canonical = findRegionalCenterByName(trimmed);
    if (canonical && canonical !== trimmed) {
      searchTerms.push(canonical);
    }
  }

  // Ищем по имени города (оригинал, затем каноническое казахское название)
  for (const term of searchTerms) {
    try {
      const data = await fetchJsonWithTimeout(
        `https://api.muftyat.kz/cities/?search=${encodeURIComponent(term)}`,
        options
      );
      const results = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
      if (results.length > 0) {
        candidates.push(...results);
        break;
      }
    } catch (err) {
      console.warn(`⚠️ Muftyat city search failed (${term}):`, err?.message || err);
    }
  }

  // Если по имени ничего — берём первую страницу (ближайший по координатам)
  if (candidates.length === 0) {
    const data = await fetchJsonWithTimeout('https://api.muftyat.kz/cities/', options);
    const results = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
    candidates.push(...results);
  }

  let nearest = null;
  let minDistKm = Infinity;

  for (const city of candidates) {
    const cityLat = Number.parseFloat(city?.lat);
    const cityLng = Number.parseFloat(city?.lng);
    if (!Number.isFinite(cityLat) || !Number.isFinite(cityLng)) continue;

    const distKm = calculateDistanceKm(numLat, numLon, cityLat, cityLng);
    if (distKm < minDistKm) {
      minDistKm = distKm;
      nearest = city;
    }
  }

  // Защита: если ближайший город Муфтията слишком далеко (например, зарубежный юзер) — fallback на Aladhan
  if (!nearest || minDistKm > maxDistanceKm) {
    return null;
  }

  return nearest;
}

/**
 * Получить времена намазов через официальный API Муфтията Казахстана
 * Используется для пользователей из Казахстана — самый точный источник
 */
export async function getPrayerTimesByMuftyat(
  latitude,
  longitude,
  timezone = DEFAULT_TIMEZONE,
  cityName = '',
  options = {}
) {
  try {
    if (!isValidCoords(latitude, longitude)) return null;

    const safeTz = resolveSafeTimezone(timezone);
    const year = getYearForTimezone(safeTz, options.now);
    const todayStr = getTodayISOForTimezone(safeTz, options.now);

    // Находим ближайший город из БД Муфтията (API требует точных координат)
    const nearestCity = await findNearestMuftyatCity(latitude, longitude, cityName, options);
    if (!nearestCity) return null;

    const lat = nearestCity.lat;
    const lng = nearestCity.lng;

    const url = `https://api.muftyat.kz/prayer-times/${year}/${encodeURIComponent(lat)}/${encodeURIComponent(lng)}`;
    const data = await fetchJsonWithTimeout(url, options);

    if (!data?.result || !Array.isArray(data.result)) return null;

    const today = data.result.find(d => d?.Date === todayStr);
    if (!today) return null;

    const normalized = {
      fajr: normalizePrayerTime(today.fajr),
      sunrise: normalizePrayerTime(today.sunrise),
      dhuhr: normalizePrayerTime(today.dhuhr),
      asr: normalizePrayerTime(today.asr),
      maghrib: normalizePrayerTime(today.maghrib),
      isha: normalizePrayerTime(today.isha),
      date: todayStr,
      lastUpdated: new Date(),
      source: 'muftyat'
    };

    if (!isValidPrayerTimes(normalized)) return null;
    return normalized;
  } catch (error) {
    console.error('❌ Ошибка получения намазов (Муфтият KZ):', error?.message || error);
    return null;
  }
}

/**
 * Получить времена намазов для города (Aladhan API)
 */
export async function getPrayerTimesByCity(city, country, timezone = DEFAULT_TIMEZONE, options = {}) {
  try {
    if (typeof city !== 'string' || !city.trim()) return null;

    const safeTz = resolveSafeTimezone(timezone);
    const dateParam = getDateForTimezone(safeTz, options.now);
    const todayStr = getTodayISOForTimezone(safeTz, options.now);
    const safeCountry = (typeof country === 'string' && country.trim()) ? country.trim() : 'Kazakhstan';
    const url = `https://api.aladhan.com/v1/timingsByCity/${dateParam}?city=${encodeURIComponent(city.trim())}&country=${encodeURIComponent(safeCountry)}&method=2`;

    const data = await fetchJsonWithTimeout(url, options);

    if (data?.code === 200 && data?.data?.timings) {
      const timings = data.data.timings;
      const normalized = {
        fajr: normalizePrayerTime(timings.Fajr),
        sunrise: normalizePrayerTime(timings.Sunrise),
        dhuhr: normalizePrayerTime(timings.Dhuhr),
        asr: normalizePrayerTime(timings.Asr),
        maghrib: normalizePrayerTime(timings.Maghrib),
        isha: normalizePrayerTime(timings.Isha),
        date: todayStr,
        lastUpdated: new Date(),
        source: 'aladhan'
      };
      if (!isValidPrayerTimes(normalized)) return null;
      return normalized;
    }

    return null;
  } catch (error) {
    console.error('❌ Ошибка получения времени намазов (город):', error?.message || error);
    return null;
  }
}

/**
 * Получить времена намазов по координатам (Aladhan API — точнее, чем по городу)
 */
export async function getPrayerTimesByCoordinates(latitude, longitude, timezone = DEFAULT_TIMEZONE, options = {}) {
  try {
    if (!isValidCoords(latitude, longitude)) return null;

    const safeTz = resolveSafeTimezone(timezone);
    const dateParam = getDateForTimezone(safeTz, options.now);
    const todayStr = getTodayISOForTimezone(safeTz, options.now);
    const url = `https://api.aladhan.com/v1/timings/${dateParam}?latitude=${encodeURIComponent(Number(latitude))}&longitude=${encodeURIComponent(Number(longitude))}&method=2`;

    const data = await fetchJsonWithTimeout(url, options);

    if (data?.code === 200 && data?.data?.timings) {
      const timings = data.data.timings;
      const normalized = {
        fajr: normalizePrayerTime(timings.Fajr),
        sunrise: normalizePrayerTime(timings.Sunrise),
        dhuhr: normalizePrayerTime(timings.Dhuhr),
        asr: normalizePrayerTime(timings.Asr),
        maghrib: normalizePrayerTime(timings.Maghrib),
        isha: normalizePrayerTime(timings.Isha),
        date: todayStr,
        lastUpdated: new Date(),
        source: 'aladhan'
      };
      if (!isValidPrayerTimes(normalized)) return null;
      return normalized;
    }

    return null;
  } catch (error) {
    console.error('❌ Ошибка получения времени намазов (координаты):', error?.message || error);
    return null;
  }
}

/**
 * Вычислить время уведомления (за N минут до намаза)
 * Чистая арифметика — НЕ зависит от timezone сервера
 */
export function calculateReminderTime(prayerTime, minutesBefore = 15) {
  const cleanTime = normalizePrayerTime(prayerTime);
  if (!cleanTime || !Number.isFinite(minutesBefore)) return null;

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
 * Определить следующий намаз и оставшееся время в секундах (в timezone пользователя)
 */
export function getNextPrayer(prayerTimes, now = new Date(), timezone = DEFAULT_TIMEZONE) {
  if (!prayerTimes || typeof prayerTimes !== 'object') return null;

  const { hour, minute, second } = getLocalTimeParts(now, timezone);
  const nowSec = hour * 3600 + minute * 60 + second;

  for (const key of PRAYER_KEYS_FOR_NEXT) {
    const clean = normalizePrayerTime(prayerTimes[key]);
    if (!clean) continue;
    const [h, m] = clean.split(':').map(Number);
    const prayerSec = h * 3600 + m * 60;
    if (prayerSec > nowSec) {
      return { key, time: clean, secondsLeft: prayerSec - nowSec };
    }
  }

  const fajrClean = normalizePrayerTime(prayerTimes.fajr);
  if (!fajrClean) return null;

  const [fh, fm] = fajrClean.split(':').map(Number);
  const fajrSec = fh * 3600 + fm * 60;
  return {
    key: 'fajr',
    time: fajrClean,
    secondsLeft: (24 * 3600 - nowSec) + fajrSec,
  };
}

/**
 * Обновить времена намазов для конкретного пользователя
 */
export async function updateUserPrayerTimes(userId, options = {}) {
  try {
    const db = options.db || getDB();
    const users = db.collection('users');

    const user = await users.findOne({ userId });
    if (!user) return false;

    // ✅ Берём timezone пользователя из БД (с безопасным фолбэком)
    const userTimezone = resolveSafeTimezone(user.location?.timezone);

    let prayerTimes = null;
    const hasCoords = isValidCoords(user.location?.latitude, user.location?.longitude);
    const explicitSource = user.prayerTimeSource;
    const isForeignCountry = Boolean(
      user.location?.country &&
      user.location.country !== 'Kazakhstan' &&
      user.location.country !== 'Other'
    );
    const inKazakhstan =
      user.location?.country === 'Kazakhstan' ||
      (hasCoords && isKazakhstanCoords(user.location.latitude, user.location.longitude));

    // По умолчанию ҚМДБ для пользователей Казахстана; пользователь может переключить на aladhan/muftyat
    const useMuftyat =
      explicitSource === 'aladhan'
        ? false
        : explicitSource === 'muftyat'
        ? true
        : inKazakhstan && !isForeignCountry;

    // ✅ ПРИОРИТЕТ 1: ҚМДБ (Муфтият) — для Казахстана (или при явном выборе muftyat)
    if (hasCoords && useMuftyat) {
      prayerTimes = await getPrayerTimesByMuftyat(
        user.location.latitude,
        user.location.longitude,
        userTimezone,
        user.location.city || '',
        options
      );
      if (prayerTimes) {
        console.log(`🕌 Муфтият KZ: userId ${userId} (${userTimezone}), дата: ${prayerTimes.date}`);
      } else {
        console.warn(`⚠️ Муфтият KZ не ответил или город вне РК, fallback на Aladhan`);
      }
    }

    // ✅ ПРИОРИТЕТ 2: Координаты (Aladhan) — для не-KZ, при выборе Aladhan или fallback
    if (!prayerTimes && hasCoords) {
      prayerTimes = await getPrayerTimesByCoordinates(
        user.location.latitude,
        user.location.longitude,
        userTimezone,
        options
      );
      if (prayerTimes) {
        console.log(`📍 Aladhan координаты: userId ${userId} (${userTimezone}), дата: ${prayerTimes.date}`);
      }
    }

    // ✅ ПРИОРИТЕТ 3: Город (Aladhan)
    if (!prayerTimes && user.location?.city) {
      prayerTimes = await getPrayerTimesByCity(
        user.location.city,
        user.location.country || 'Kazakhstan',
        userTimezone,
        options
      );
      if (prayerTimes) {
        console.log(`🏙️ Город ${user.location.city}: userId ${userId} (${userTimezone}), дата: ${prayerTimes.date}`);
      }
    }

    if (prayerTimes) {
      await users.updateOne(
        { userId },
        { $set: { prayerTimes, updatedAt: new Date() } }
      );
      console.log(`✅ Намазы обновлены: Fajr ${prayerTimes.fajr}, Maghrib ${prayerTimes.maghrib}`);
      return true;
    }

    console.warn(`⚠️ Не удалось обновить намазы для userId ${userId} — нет локации или API недоступны`);
    return false;
  } catch (error) {
    console.error(`❌ Ошибка обновления намазов userId ${userId}:`, error?.message || error);
    return false;
  }
}
