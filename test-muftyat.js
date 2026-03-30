// test-muftyat.js — запустить: node test-muftyat.js
import fetch from 'node-fetch';

// Произвольные GPS координаты (как от Telegram геолокации)
const LAT = 43.2220;  // Алматы
const LNG = 76.8512;
const TZ  = 'Asia/Almaty';

function getTodayISO(timezone) {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone });
}

async function findNearestMuftyatCity(latitude, longitude) {
  const res = await fetch('https://api.muftyat.kz/cities/');
  const data = await res.json();
  const cities = Array.isArray(data.results) ? data.results : (Array.isArray(data) ? data : []);

  let nearest = null;
  let minDist = Infinity;
  for (const city of cities) {
    const dlat = parseFloat(city.lat) - latitude;
    const dlng = parseFloat(city.lng) - longitude;
    const dist = dlat * dlat + dlng * dlng;
    if (dist < minDist) { minDist = dist; nearest = city; }
  }
  return nearest;
}

async function testMuftyat() {
  console.log(`📍 Входные координаты: ${LAT}, ${LNG}\n`);

  console.log('🔍 Ищем ближайший город в БД Муфтията...');
  const city = await findNearestMuftyatCity(LAT, LNG);
  if (!city) { console.log('❌ Не удалось получить список городов'); return; }
  console.log(`✅ Ближайший город: ${city.title} (${city.lat}, ${city.lng})\n`);

  const todayStr = getTodayISO(TZ);
  const year = todayStr.split('-')[0];
  const url = `https://api.muftyat.kz/prayer-times/${year}/${city.lat}/${city.lng}`;
  console.log(`🕌 Запрос: ${url}`);

  const res = await fetch(url);
  const data = await res.json();

  if (!data.result) { console.log('❌ Ответ:', data); return; }

  const today = data.result.find(d => d.Date === todayStr);
  if (!today) { console.log(`❌ Дата ${todayStr} не найдена`); return; }

  console.log('\n✅ Муфтият KZ:');
  console.table({ Таң: today.fajr, Шығу: today.sunrise, Бесін: today.dhuhr, Екінті: today.asr, Ақшам: today.maghrib, Құптан: today.isha });
}

async function testAladhan() {
  const d = new Date().toLocaleDateString('en-GB', { timeZone: TZ, day:'2-digit', month:'2-digit', year:'numeric' });
  const [day, mon, yr] = d.split('/');
  const url = `https://api.aladhan.com/v1/timings/${day}-${mon}-${yr}?latitude=${LAT}&longitude=${LNG}&method=2`;
  console.log(`\n📡 Для сравнения — Aladhan:`);
  const res = await fetch(url);
  const data = await res.json();
  if (data.code === 200) {
    const t = data.data.timings;
    console.table({ Таң: t.Fajr, Шығу: t.Sunrise, Бесін: t.Dhuhr, Екінті: t.Asr, Ақшам: t.Maghrib, Құптан: t.Isha });
  }
}

await testMuftyat();
await testAladhan();
