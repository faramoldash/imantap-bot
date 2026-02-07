// prayerTimesService.js
import fetch from 'node-fetch';
import { getDB } from './db.js';

/**
 * Получить времена намазов для города
 */
export async function getPrayerTimesByCity(city, country) {
  try {
    const url = `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&method=2`;
    
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
        lastUpdated: new Date()
      };
    }
    
    return null;
  } catch (error) {
    console.error('❌ Ошибка получения времени намазов:', error);
    return null;
  }
}

/**
 * Получить времена намазов по координатам (ТОЧНЕЕ!)
 */
export async function getPrayerTimesByCoordinates(latitude, longitude) {
  try {
    const url = `https://api.aladhan.com/v1/timings?latitude=${latitude}&longitude=${longitude}&method=2`;
    
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
        lastUpdated: new Date()
      };
    }
    
    return null;
  } catch (error) {
    console.error('❌ Ошибка получения времени намазов:', error);
    return null;
  }
}

/**
 * Вычислить время уведомления (за N минут до намаза)
 */
export function calculateReminderTime(prayerTime, minutesBefore = 30) {
  // prayerTime в формате "05:25"
  const [hours, minutes] = prayerTime.split(':').map(Number);
  
  const prayerDate = new Date();
  prayerDate.setHours(hours, minutes, 0, 0);
  
  const reminderDate = new Date(prayerDate.getTime() - minutesBefore * 60 * 1000);
  
  return {
    hour: reminderDate.getHours(),
    minute: reminderDate.getMinutes()
  };
}

/**
 * Обновить времена намазов для пользователя
 */
export async function updateUserPrayerTimes(userId) {
  try {
    const db = getDB();
    const users = db.collection('users');
    
    const user = await users.findOne({ userId });
    if (!user) return false;
    
    let prayerTimes = null;
    
    // ✅ ПРИОРИТЕТ 1: Координаты (самое точное!)
    if (user.location?.latitude && user.location?.longitude) {
      prayerTimes = await getPrayerTimesByCoordinates(
        user.location.latitude,
        user.location.longitude
      );
      console.log(`📍 Использованы координаты для userId ${userId}`);
    }
    // ✅ ПРИОРИТЕТ 2: Город (запасной вариант)
    else if (user.location?.city) {
      prayerTimes = await getPrayerTimesByCity(
        user.location.city,
        user.location.country || 'Kazakhstan'
      );
      console.log(`🏙️ Использован город ${user.location.city} для userId ${userId}`);
    }
    
    if (prayerTimes) {
      await users.updateOne(
        { userId },
        { $set: { prayerTimes, updatedAt: new Date() } }
      );
      console.log(`✅ Времена обновлены: Fajr ${prayerTimes.fajr}, Maghrib ${prayerTimes.maghrib}`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error(`❌ Ошибка обновления для ${userId}:`, error);
    return false;
  }
}
