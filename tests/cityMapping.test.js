import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRegionalCenter,
  findRegionalCenterByName,
  getRegionalCenterByCoords,
  getCityByCoordinates,
  isValidCoords,
  isKazakhstanCoords,
  getKazakhstanCities,
} from '../utils/cityMapping.js';

test('findRegionalCenterByName handles Cyrillic, Latin, mixed case, and suffixes', () => {
  assert.equal(findRegionalCenterByName('Алматы'), 'Алматы');
  assert.equal(findRegionalCenterByName('АЛМАТЫ'), 'Алматы');
  assert.equal(findRegionalCenterByName('  almaty  '), 'Алматы');
  assert.equal(findRegionalCenterByName('Алматы қаласы'), 'Алматы');
  assert.equal(findRegionalCenterByName('г. Караганда'), 'Қарағанды');
  assert.equal(findRegionalCenterByName('Astana city'), 'Астана');
  assert.equal(findRegionalCenterByName('nur-sultan'), 'Астана');
  assert.equal(findRegionalCenterByName('Nur Sultan'), 'Астана');
  assert.equal(findRegionalCenterByName('Нұр-Сұлтан'), 'Астана');
  assert.equal(findRegionalCenterByName('усть-каменогорск'), 'Өскемен');
  assert.equal(findRegionalCenterByName('Öskemen'), 'Өскемен');
  assert.equal(findRegionalCenterByName('Қапшағай'), 'Қонаев');
  assert.equal(findRegionalCenterByName('qonayev'), 'Қонаев');
  assert.equal(findRegionalCenterByName('Чимкент'), 'Шымкент');
  assert.equal(findRegionalCenterByName('shimkent'), 'Шымкент');
  assert.equal(findRegionalCenterByName('Ақтөбе облысы'), 'Ақтөбе');
});

test('findRegionalCenterByName and getRegionalCenter safely handle invalid inputs without crashing', () => {
  assert.equal(findRegionalCenterByName(null), null);
  assert.equal(findRegionalCenterByName(undefined), null);
  assert.equal(findRegionalCenterByName(12345), null);
  assert.equal(findRegionalCenterByName('   '), null);
  assert.equal(findRegionalCenterByName('Москва'), null);

  assert.equal(getRegionalCenter(null, null, null), 'Астана');
  assert.equal(getRegionalCenter(undefined, NaN, NaN), 'Астана');
  assert.equal(getRegionalCenter('UnknownVillage', 43.2389, 76.8897), 'Алматы');
});

test('isValidCoords and isKazakhstanCoords handle edge cases including 0 coords', () => {
  assert.equal(isValidCoords(0, 0), true);
  assert.equal(isValidCoords(51.1694, 71.4491), true);
  assert.equal(isValidCoords(null, 71.4), false);
  assert.equal(isValidCoords('', 71.4), false);
  assert.equal(isValidCoords(NaN, 71.4), false);
  assert.equal(isValidCoords(95, 71.4), false);

  assert.equal(isKazakhstanCoords(43.2389, 76.8897), true); // Almaty
  assert.equal(isKazakhstanCoords(51.1694, 71.4491), true); // Astana
  assert.equal(isKazakhstanCoords(55.7558, 37.6173), false); // Moscow
  assert.equal(isKazakhstanCoords(25.2048, 55.2708), false); // Dubai
  assert.equal(isKazakhstanCoords(0, 0), false);
});

test('getRegionalCenterByCoords maps Kazakhstan regions and safely handles bad coords', () => {
  assert.equal(getRegionalCenterByCoords(51.1694, 71.4491), 'Астана');
  assert.equal(getRegionalCenterByCoords(43.2389, 76.8897), 'Алматы');
  assert.equal(getRegionalCenterByCoords(42.3417, 69.5901), 'Шымкент');
  assert.equal(getRegionalCenterByCoords(43.6532, 51.1975), 'Ақтау');
  assert.equal(getRegionalCenterByCoords(NaN, undefined), 'Астана');
  assert.equal(getKazakhstanCities().length, 20);
});

test('getCityByCoordinates maps KZ Nominatim result, preserves foreign cities, and falls back on error/timeout', async () => {
  // 1. KZ city with suffix from Nominatim
  const kzCity = await getCityByCoordinates(43.2389, 76.8897, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        display_name: 'Алматы қаласы, Қазақстан',
        address: { city: 'Алматы қаласы', country_code: 'kz' },
      }),
    }),
  });
  assert.equal(kzCity, 'Алматы');

  // 2. Foreign city is preserved rather than overwritten with a KZ regional center
  const foreignCity = await getCityByCoordinates(55.7558, 37.6173, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        display_name: 'Москва, Россия',
        address: { city: 'Москва', country_code: 'ru' },
      }),
    }),
  });
  assert.equal(foreignCity, 'Москва');

  // 3. HTTP 429 rate-limit -> graceful fallback to coordinates
  const rateLimited = await getCityByCoordinates(43.2389, 76.8897, {
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
  });
  assert.equal(rateLimited, 'Алматы');

  // 4. Timeout triggers AbortController -> graceful fallback to coordinates
  const timedOut = await getCityByCoordinates(51.1694, 71.4491, {
    timeoutMs: 25,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Aborted')));
    }),
  });
  assert.equal(timedOut, 'Астана');
});
