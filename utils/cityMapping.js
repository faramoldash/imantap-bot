// 20 областных центров + 3 города республиканского значения
const REGIONAL_CENTERS = {
  // Города республиканского значения
  'Астана': 'Астана',
  'Astana': 'Астана',
  'Nur-Sultan': 'Астана',
  'Nur Sultan': 'Астана',
  'Nursultan': 'Астана',
  'Нур-Султан': 'Астана',
  'Нұр-Сұлтан': 'Астана',
  'Нурсултан': 'Астана',

  'Алматы': 'Алматы',
  'Almaty': 'Алматы',

  'Шымкент': 'Шымкент',
  'Shymkent': 'Шымкент',
  'Shimkent': 'Шымкент',
  'Chimkent': 'Шымкент',
  'Чимкент': 'Шымкент',

  // Областные центры (17 областей + 3 города = 20 центров)
  'Семей': 'Семей',
  'Semey': 'Семей',
  'Semei': 'Семей',

  'Көкшетау': 'Көкшетау',
  'Кокшетау': 'Көкшетау',
  'Kokshetau': 'Көкшетау',
  'Kokshetay': 'Көкшетау',
  'Кокчетав': 'Көкшетау',

  'Ақтөбе': 'Ақтөбе',
  'Актобе': 'Ақтөбе',
  'Aktobe': 'Ақтөбе',
  'Aqtobe': 'Ақтөбе',
  'Aktube': 'Ақтөбе',
  'Актюбинск': 'Ақтөбе',

  'Қонаев': 'Қонаев',
  'Конаев': 'Қонаев',
  'Konaev': 'Қонаев',
  'Konayev': 'Қонаев',
  'Qonaev': 'Қонаев',
  'Qonayev': 'Қонаев',
  'Kapchagay': 'Қонаев',
  'Капшагай': 'Қонаев',
  'Қапшағай': 'Қонаев',

  'Атырау': 'Атырау',
  'Atyrau': 'Атырау',
  'Гурьев': 'Атырау',

  'Өскемен': 'Өскемен',
  'Усть-Каменогорск': 'Өскемен',
  'Oskemen': 'Өскемен',
  'Öskemen': 'Өскемен',
  'Ust-Kamenogorsk': 'Өскемен',
  'Ust Kamenogorsk': 'Өскемен',

  'Тараз': 'Тараз',
  'Taraz': 'Тараз',
  'Жамбыл': 'Тараз',
  'Джамбул': 'Тараз',

  'Талдықорған': 'Талдықорған',
  'Талдыкорган': 'Талдықорған',
  'Taldykorgan': 'Талдықорған',
  'Taldyqorgan': 'Талдықорған',

  'Орал': 'Орал',
  'Уральск': 'Орал',
  'Oral': 'Орал',
  'Uralsk': 'Орал',

  'Қарағанды': 'Қарағанды',
  'Караганда': 'Қарағанды',
  'Karaganda': 'Қарағанды',
  'Karagandy': 'Қарағанды',
  'Qaragandy': 'Қарағанды',
  'Qaraganda': 'Қарағанды',

  'Қостанай': 'Қостанай',
  'Костанай': 'Қостанай',
  'Кустанай': 'Қостанай',
  'Kostanay': 'Қостанай',
  'Kostanai': 'Қостанай',
  'Qostanay': 'Қостанай',
  'Qostanai': 'Қостанай',

  'Қызылорда': 'Қызылорда',
  'Кызылорда': 'Қызылорда',
  'Kyzylorda': 'Қызылорда',
  'Qyzylorda': 'Қызылорда',
  'Kizilorda': 'Қызылорда',

  'Ақтау': 'Ақтау',
  'Актау': 'Ақтау',
  'Aktau': 'Ақтау',
  'Aqtau': 'Ақтау',

  'Павлодар': 'Павлодар',
  'Pavlodar': 'Павлодар',

  'Петропавл': 'Петропавл',
  'Петропавловск': 'Петропавл',
  'Petropavl': 'Петропавл',
  'Petropavlovsk': 'Петропавл',

  'Түркістан': 'Түркістан',
  'Туркестан': 'Түркістан',
  'Turkistan': 'Түркістан',
  'Turkestan': 'Түркістан',

  'Жезқазған': 'Жезқазған',
  'Жезказган': 'Жезқазған',
  'Джезказган': 'Жезқазған',
  'Zhezkazgan': 'Жезқазған',
  'Zhezqazgan': 'Жезқазған',
  'Dzhezkazgan': 'Жезқазған',
};

const DEFAULT_NOMINATIM_TIMEOUT_MS = 6000;

/**
 * Нормализация названия города для устойчивого поиска (регистр, пробелы, префиксы/суффиксы)
 */
function normalizeCityKey(cityName) {
  if (typeof cityName !== 'string') return '';

  return cityName
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/^(?:г\.|г\s+|город\s+|қ\.|қ\s+|қала\s+|city\s+of\s+)/i, '')
    .replace(/\s*(?:қаласы|қала|қ\.|город|г\.|облысы|область|city|municipality)$/i, '')
    .replace(/[-–—_.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Индекс для быстрого регистронезависимого поиска
const NORMALIZED_REGIONAL_CENTERS = new Map();
const COMPACT_REGIONAL_CENTERS = new Map();

for (const [alias, canonical] of Object.entries(REGIONAL_CENTERS)) {
  const normalized = normalizeCityKey(alias);
  if (normalized) {
    NORMALIZED_REGIONAL_CENTERS.set(normalized, canonical);
    COMPACT_REGIONAL_CENTERS.set(normalized.replace(/\s+/g, ''), canonical);
  }
}

/**
 * Проверка валидности координат (допускает 0° широты/долготы)
 */
function isValidCoords(lat, lon) {
  if (lat === null || lat === undefined || lat === '' || lon === null || lon === undefined || lon === '') {
    return false;
  }
  const numLat = Number(lat);
  const numLon = Number(lon);
  return (
    Number.isFinite(numLat) &&
    Number.isFinite(numLon) &&
    numLat >= -90 && numLat <= 90 &&
    numLon >= -180 && numLon <= 180
  );
}

/**
 * Проверка, находятся ли координаты в пределах Казахстана (bounding box)
 */
function isKazakhstanCoords(lat, lon) {
  if (!isValidCoords(lat, lon)) return false;
  const numLat = Number(lat);
  const numLon = Number(lon);
  return numLat >= 40.5 && numLat <= 55.5 && numLon >= 46.5 && numLon <= 87.5;
}

/**
 * Поиск областного центра ТОЛЬКО по названию (без fallback на координаты/Астану)
 */
function findRegionalCenterByName(cityName) {
  if (typeof cityName !== 'string') return null;
  const trimmed = cityName.trim();
  if (!trimmed) return null;

  if (REGIONAL_CENTERS[trimmed]) {
    return REGIONAL_CENTERS[trimmed];
  }

  const normalized = normalizeCityKey(trimmed);
  if (!normalized) return null;

  if (NORMALIZED_REGIONAL_CENTERS.has(normalized)) {
    return NORMALIZED_REGIONAL_CENTERS.get(normalized);
  }

  const compact = normalized.replace(/\s+/g, '');
  if (COMPACT_REGIONAL_CENTERS.has(compact)) {
    return COMPACT_REGIONAL_CENTERS.get(compact);
  }

  return null;
}

// Mapping областей по координатам (уточненные границы)
const REGION_BY_COORDINATES = [
  // Астана
  { lat: [50.9, 51.3], lon: [71.2, 71.7], center: 'Астана' },

  // Алматы
  { lat: [43.1, 43.4], lon: [76.7, 77.1], center: 'Алматы' },

  // Шымкент
  { lat: [42.2, 42.4], lon: [69.4, 69.8], center: 'Шымкент' },

  // Абайская область (Семей)
  { lat: [49.5, 51.0], lon: [79.0, 82.0], center: 'Семей' },

  // Акмолинская область (Көкшетау)
  { lat: [52.5, 53.5], lon: [68.5, 70.5], center: 'Көкшетау' },

  // Актюбинская область
  { lat: [48.5, 51.5], lon: [55.0, 61.0], center: 'Ақтөбе' },

  // Алматинская область (Қонаев)
  { lat: [43.0, 44.5], lon: [77.0, 79.5], center: 'Қонаев' },

  // Атырауская область
  { lat: [46.0, 48.0], lon: [49.5, 53.0], center: 'Атырау' },

  // Восточно-Казахстанская область (Өскемен)
  { lat: [48.5, 50.5], lon: [80.5, 85.0], center: 'Өскемен' },

  // Жамбылская область (Тараз)
  { lat: [42.5, 44.0], lon: [70.5, 73.0], center: 'Тараз' },

  // Жетысуская область (Талдықорған)
  { lat: [44.5, 46.5], lon: [78.0, 81.0], center: 'Талдықорған' },

  // Западно-Казахстанская область (Орал)
  { lat: [49.5, 51.5], lon: [50.0, 54.5], center: 'Орал' },

  // Карагандинская область
  { lat: [47.5, 50.5], lon: [71.0, 76.0], center: 'Қарағанды' },

  // Костанайская область
  { lat: [51.5, 54.0], lon: [61.0, 68.0], center: 'Қостанай' },

  // Кызылординская область
  { lat: [43.5, 46.5], lon: [60.5, 66.5], center: 'Қызылорда' },

  // Мангистауская область (Ақтау)
  { lat: [43.0, 45.5], lon: [50.0, 55.0], center: 'Ақтау' },

  // Павлодарская область
  { lat: [51.5, 53.5], lon: [75.0, 79.5], center: 'Павлодар' },

  // Северо-Казахстанская область (Петропавл)
  { lat: [53.5, 55.0], lon: [68.0, 70.0], center: 'Петропавл' },

  // Туркестанская область
  { lat: [41.5, 43.0], lon: [67.0, 69.5], center: 'Түркістан' },

  // Улытауская область (Жезқазған)
  { lat: [46.5, 48.5], lon: [66.5, 70.5], center: 'Жезқазған' },
];

/**
 * Получить список городов для фильтра (на казахском)
 */
function getKazakhstanCities() {
  return [
    'Астана',
    'Алматы',
    'Шымкент',
    'Ақтау',
    'Ақтөбе',
    'Атырау',
    'Жезқазған',
    'Көкшетау',
    'Қарағанды',
    'Қонаев',
    'Қостанай',
    'Қызылорда',
    'Орал',
    'Павлодар',
    'Петропавл',
    'Семей',
    'Талдықорған',
    'Тараз',
    'Түркістан',
    'Өскемен',
  ].sort();
}

/**
 * Определить город / областной центр по координатам через Nominatim API
 */
async function getCityByCoordinates(lat, lon, options = {}) {
  if (!isValidCoords(lat, lon)) {
    return 'Астана';
  }

  const numLat = Number(lat);
  const numLon = Number(lon);
  const fetchFn = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_NOMINATIM_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(
      `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(numLat)}&lon=${encodeURIComponent(numLon)}&format=json&accept-language=kk`,
      {
        headers: {
          'User-Agent': 'ImanTap/1.0' // Nominatim требует User-Agent
        },
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      throw new Error(`Geocoding failed with status ${response.status}`);
    }

    const data = await response.json();

    // Извлекаем город из ответа
    const city = data?.address?.city ||
                 data?.address?.town ||
                 data?.address?.village ||
                 data?.address?.state;
    const countryCode = typeof data?.address?.country_code === 'string'
      ? data.address.country_code.toLowerCase()
      : '';

    console.log('📍 Geocoding result:', {
      lat: numLat,
      lon: numLon,
      city,
      countryCode,
      fullAddress: data?.display_name
    });

    if (city) {
      // Для зарубежных городов сохраняем реальное название города, не подменяем областным центром РК
      if (countryCode && countryCode !== 'kz') {
        return String(city).trim();
      }
      return getRegionalCenter(city, numLat, numLon);
    }

    // Если не определен, используем координаты
    return getRegionalCenterByCoords(numLat, numLon);

  } catch (error) {
    console.error('❌ Geocoding error:', error?.message || error);
    // Fallback на определение по координатам
    return getRegionalCenterByCoords(numLat, numLon);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Определить областной центр только по координатам (без API)
 */
function getRegionalCenterByCoords(lat, lon) {
  if (!isValidCoords(lat, lon)) {
    return 'Астана';
  }

  const numLat = Number(lat);
  const numLon = Number(lon);

  for (const region of REGION_BY_COORDINATES) {
    if (
      numLat >= region.lat[0] && numLat <= region.lat[1] &&
      numLon >= region.lon[0] && numLon <= region.lon[1]
    ) {
      return region.center;
    }
  }

  // Если не попал ни в одну область, возвращаем ближайший областной центр
  let minDistance = Infinity;
  let closestCenter = 'Астана';

  for (const region of REGION_BY_COORDINATES) {
    const centerLat = (region.lat[0] + region.lat[1]) / 2;
    const centerLon = (region.lon[0] + region.lon[1]) / 2;
    const distance = Math.sqrt(
      Math.pow(numLat - centerLat, 2) + Math.pow(numLon - centerLon, 2)
    );

    if (distance < minDistance) {
      minDistance = distance;
      closestCenter = region.center;
    }
  }

  console.log(`📍 Fallback: closest center for [${numLat}, ${numLon}] is ${closestCenter}`);
  return closestCenter;
}

/**
 * Определить областной центр по названию города
 */
function getRegionalCenter(cityName, lat, lon) {
  // 1. Проверяем прямое и нормализованное совпадение (регистр, латиница/кириллица, суффиксы)
  const matched = findRegionalCenterByName(cityName);
  if (matched) {
    return matched;
  }

  // 2. Если есть валидные координаты, используем их
  if (isValidCoords(lat, lon)) {
    return getRegionalCenterByCoords(Number(lat), Number(lon));
  }

  // 3. Fallback
  return 'Астана';
}

export {
  getCityByCoordinates,
  getRegionalCenter,
  getRegionalCenterByCoords,
  getKazakhstanCities,
  findRegionalCenterByName,
  normalizeCityKey,
  isValidCoords,
  isKazakhstanCoords,
  REGIONAL_CENTERS,
};
