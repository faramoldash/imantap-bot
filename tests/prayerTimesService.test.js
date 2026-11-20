import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGO_URL ||= 'mongodb://127.0.0.1:27017/imantap_unit_test';

const {
  DEFAULT_TIMEZONE,
  resolveSafeTimezone,
  getLocalTimeParts,
  getTodayISOForTimezone,
  getDateForTimezone,
  normalizePrayerTime,
  isValidPrayerTimes,
  calculateReminderTime,
  getNextPrayer,
  findNearestMuftyatCity,
  getPrayerTimesByMuftyat,
  getPrayerTimesByCoordinates,
  getPrayerTimesByCity,
  updateUserPrayerTimes,
} = await import('../prayerTimesService.js');

const {
  shouldRefreshUserPrayerTimes,
  isTelegramBlockedError,
} = await import('../schedulerService.js');

const SAMPLE_PRAYER_TIMES = {
  fajr: '05:00',
  sunrise: '06:30',
  dhuhr: '12:30',
  asr: '16:15',
  maghrib: '18:45',
  isha: '20:15',
};

test('resolveSafeTimezone and local date/time helpers handle midnight and invalid timezones', () => {
  assert.equal(resolveSafeTimezone('Asia/Almaty'), 'Asia/Almaty');
  assert.equal(resolveSafeTimezone('Europe/Moscow'), 'Europe/Moscow');
  assert.equal(resolveSafeTimezone('Invalid/Zone'), DEFAULT_TIMEZONE);
  assert.equal(resolveSafeTimezone(''), DEFAULT_TIMEZONE);
  assert.equal(resolveSafeTimezone(null), DEFAULT_TIMEZONE);

  // 19:05 UTC = 00:05 next day in Asia/Almaty (UTC+5) — must be hour 0, never 24
  const midnightAlmaty = new Date('2026-03-26T19:05:09Z');
  const parts = getLocalTimeParts(midnightAlmaty, 'Asia/Almaty');
  assert.equal(parts.hour, 0);
  assert.equal(parts.minute, 5);
  assert.equal(parts.second, 9);
  assert.equal(parts.dateStr, '2026-03-27');
  assert.equal(getTodayISOForTimezone('Asia/Almaty', midnightAlmaty), '2026-03-27');
  assert.equal(getDateForTimezone('Asia/Almaty', midnightAlmaty), '27-03-2026');
});

test('normalizePrayerTime strips Aladhan timezone suffixes and rejects invalid strings', () => {
  assert.equal(normalizePrayerTime('05:12'), '05:12');
  assert.equal(normalizePrayerTime('5:07 (+05)'), '05:07');
  assert.equal(normalizePrayerTime('18:45 (AQTT)'), '18:45');
  assert.equal(normalizePrayerTime('25:00'), null);
  assert.equal(normalizePrayerTime('12:60'), null);
  assert.equal(normalizePrayerTime('invalid'), null);
  assert.equal(normalizePrayerTime(null), null);

  assert.equal(isValidPrayerTimes(SAMPLE_PRAYER_TIMES), true);
  assert.equal(isValidPrayerTimes({ ...SAMPLE_PRAYER_TIMES, maghrib: 'bad' }), false);
  assert.equal(isValidPrayerTimes(null), false);
});

test('calculateReminderTime handles offsets, suffixes, midnight wrap, and invalid input', () => {
  assert.deepEqual(calculateReminderTime('05:30', 15), { hour: 5, minute: 15 });
  assert.deepEqual(calculateReminderTime('05:30 (+05)', 10), { hour: 5, minute: 20 });
  assert.deepEqual(calculateReminderTime('00:10', 30), { hour: 23, minute: 40 });
  assert.deepEqual(calculateReminderTime('00:00', 15), { hour: 23, minute: 45 });
  assert.equal(calculateReminderTime('not-a-time', 15), null);
  assert.equal(calculateReminderTime(undefined, 15), null);
});

test('getNextPrayer resolves upcoming prayer, skips sunrise, wraps after Isha, and respects timezone', () => {
  // 04:30 Almaty (23:30 UTC previous day) -> Fajr in 30 min
  const beforeFajr = new Date('2026-03-25T23:30:00Z');
  assert.deepEqual(getNextPrayer(SAMPLE_PRAYER_TIMES, beforeFajr, 'Asia/Almaty'), {
    key: 'fajr',
    time: '05:00',
    secondsLeft: 30 * 60,
  });

  // 05:30 Almaty (00:30 UTC) -> Dhuhr (skips Sunrise 06:30)
  const afterFajr = new Date('2026-03-26T00:30:00Z');
  assert.deepEqual(getNextPrayer(SAMPLE_PRAYER_TIMES, afterFajr, 'Asia/Almaty'), {
    key: 'dhuhr',
    time: '12:30',
    secondsLeft: 7 * 3600,
  });

  // 22:00 Almaty (17:00 UTC) -> wraps to tomorrow Fajr (2h + 5h = 7h)
  const afterIsha = new Date('2026-03-26T17:00:00Z');
  assert.deepEqual(getNextPrayer(SAMPLE_PRAYER_TIMES, afterIsha, 'Asia/Almaty'), {
    key: 'fajr',
    time: '05:00',
    secondsLeft: 7 * 3600,
  });

  // Same UTC instant in Europe/Moscow (UTC+3 = 20:00) -> Isha at 20:15 in 15 min!
  assert.deepEqual(getNextPrayer(SAMPLE_PRAYER_TIMES, afterIsha, 'Europe/Moscow'), {
    key: 'isha',
    time: '20:15',
    secondsLeft: 15 * 60,
  });

  // Handles Aladhan timezone suffixes and missing input safely
  const withSuffix = { ...SAMPLE_PRAYER_TIMES, dhuhr: '12:30 (+05)' };
  assert.equal(getNextPrayer(withSuffix, afterFajr, 'Asia/Almaty')?.key, 'dhuhr');
  assert.equal(getNextPrayer(null, afterFajr, 'Asia/Almaty'), null);
});

test('Muftyat KZ city lookup rejects distant foreign coords and supports Kazakh canonical search', async () => {
  const requestedUrls = [];
  const mockFetch = async (url) => {
    requestedUrls.push(url);
    if (url.includes('search=Almaty')) {
      return { ok: true, json: async () => ({ results: [] }) };
    }
    if (url.includes(`search=${encodeURIComponent('Алматы')}`)) {
      return {
        ok: true,
        json: async () => ({
          results: [{ title: 'Алматы', lat: '43.2389', lng: '76.8897' }],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        results: [{ title: 'Алматы', lat: '43.2389', lng: '76.8897' }],
      }),
    };
  };

  // Latin "Almaty" falls back to canonical "Алматы" search and matches
  const almaty = await findNearestMuftyatCity(43.24, 76.89, 'Almaty', { fetchImpl: mockFetch });
  assert.equal(almaty?.title, 'Алматы');
  assert.ok(requestedUrls.some(u => u.includes(encodeURIComponent('Алматы'))));

  // Moscow coordinates are >350km from Almaty -> rejected (returns null for Aladhan fallback)
  const moscow = await findNearestMuftyatCity(55.7558, 37.6173, 'Москва', { fetchImpl: mockFetch });
  assert.equal(moscow, null);
});

test('Aladhan and Muftyat API wrappers handle timeouts, HTTP 429, and strip timezone suffixes', async () => {
  const fixedNow = new Date('2026-03-26T06:00:00Z');

  // Aladhan coordinates happy path with suffixes
  const aladhan = await getPrayerTimesByCoordinates(51.1694, 71.4491, 'Asia/Almaty', {
    now: fixedNow,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        code: 200,
        data: {
          timings: {
            Fajr: '05:10 (+05)',
            Sunrise: '06:45 (+05)',
            Dhuhr: '12:55 (+05)',
            Asr: '16:30 (+05)',
            Maghrib: '19:05 (+05)',
            Isha: '20:35 (+05)',
          },
        },
      }),
    }),
  });
  assert.equal(aladhan?.fajr, '05:10');
  assert.equal(aladhan?.maghrib, '19:05');
  assert.equal(aladhan?.source, 'aladhan');
  assert.equal(aladhan?.date, '2026-03-26');

  // HTTP 429 -> returns null safely
  const rateLimited = await getPrayerTimesByCity('Astana', 'Kazakhstan', 'Asia/Almaty', {
    now: fixedNow,
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
  });
  assert.equal(rateLimited, null);

  // Timeout -> returns null safely without hanging
  const timedOut = await getPrayerTimesByMuftyat(51.1694, 71.4491, 'Asia/Almaty', 'Астана', {
    now: fixedNow,
    timeoutMs: 25,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Aborted')));
    }),
  });
  assert.equal(timedOut, null);
});

test('updateUserPrayerTimes executes Muftyat -> Aladhan fallback chain and supports 0,0 coords', async () => {
  const fixedNow = new Date('2026-03-26T06:00:00Z');

  function createFakeDb(userDoc) {
    let stored = structuredClone(userDoc);
    return {
      getStored: () => stored,
      collection: () => ({
        findOne: async () => stored,
        updateOne: async (_filter, update) => {
          stored = { ...stored, ...update.$set };
          return { modifiedCount: 1 };
        },
      }),
    };
  }

  // Case 1: KZ user, Muftyat returns 503 -> falls back to Aladhan coordinates
  const kzDb = createFakeDb({
    userId: 101,
    location: { city: 'Алматы', country: 'Kazakhstan', latitude: 43.2389, longitude: 76.8897, timezone: 'Asia/Almaty' },
  });
  const ok1 = await updateUserPrayerTimes(101, {
    db: kzDb,
    now: fixedNow,
    fetchImpl: async (url) => {
      if (url.includes('api.muftyat.kz')) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => ({
          code: 200,
          data: {
            timings: {
              Fajr: '05:05',
              Sunrise: '06:35',
              Dhuhr: '12:45',
              Asr: '16:20',
              Maghrib: '18:55',
              Isha: '20:25',
            },
          },
        }),
      };
    },
  });
  assert.equal(ok1, true);
  assert.equal(kzDb.getStored().prayerTimes.source, 'aladhan');
  assert.equal(kzDb.getStored().prayerTimes.fajr, '05:05');

  // Case 2: Foreign user at (0, 0) coords -> skips Muftyat and succeeds via Aladhan coordinates
  const zeroCoordsDb = createFakeDb({
    userId: 102,
    location: { city: 'Accra', country: 'Ghana', latitude: 0, longitude: 0, timezone: 'UTC' },
  });
  let muftyatCalled = false;
  const ok2 = await updateUserPrayerTimes(102, {
    db: zeroCoordsDb,
    now: fixedNow,
    fetchImpl: async (url) => {
      if (url.includes('api.muftyat.kz')) muftyatCalled = true;
      return {
        ok: true,
        json: async () => ({
          code: 200,
          data: {
            timings: {
              Fajr: '04:50',
              Sunrise: '06:00',
              Dhuhr: '12:10',
              Asr: '15:30',
              Maghrib: '18:15',
              Isha: '19:30',
            },
          },
        }),
      };
    },
  });
  assert.equal(ok2, true);
  assert.equal(muftyatCalled, false);
  assert.equal(zeroCoordsDb.getStored().prayerTimes.source, 'aladhan');
});

test('shouldRefreshUserPrayerTimes respects user timezone and deduplicates same-day refreshes', () => {
  // 19:30 UTC = 00:30 Almaty (2026-03-27), 22:30 Moscow (2026-03-26)
  const at1930Utc = new Date('2026-03-26T19:30:00Z');

  const almatyUserStale = {
    location: { city: 'Алматы', timezone: 'Asia/Almaty' },
    prayerTimes: { date: '2026-03-26', fajr: '05:00' },
  };
  const almatyUserFresh = {
    location: { city: 'Алматы', timezone: 'Asia/Almaty' },
    prayerTimes: { date: '2026-03-27', fajr: '04:58' },
  };
  const moscowUser = {
    location: { city: 'Москва', timezone: 'Europe/Moscow' },
    prayerTimes: { date: '2026-03-26', fajr: '04:40' },
  };

  assert.equal(shouldRefreshUserPrayerTimes(almatyUserStale, at1930Utc), true);
  assert.equal(shouldRefreshUserPrayerTimes(almatyUserFresh, at1930Utc), false);
  assert.equal(shouldRefreshUserPrayerTimes(moscowUser, at1930Utc), false);

  // 21:30 UTC = 00:30 Moscow (2026-03-27) -> Moscow refreshes now
  const at2130Utc = new Date('2026-03-26T21:30:00Z');
  assert.equal(shouldRefreshUserPrayerTimes(moscowUser, at2130Utc), true);
});

test('isTelegramBlockedError identifies 403 and deactivated/chat-not-found errors only', () => {
  assert.equal(isTelegramBlockedError({ response: { body: { error_code: 403 } } }), true);
  assert.equal(
    isTelegramBlockedError({ response: { body: { error_code: 400, description: 'Bad Request: chat not found' } } }),
    true
  );
  assert.equal(
    isTelegramBlockedError({ response: { body: { error_code: 400, description: 'Forbidden: user is deactivated' } } }),
    true
  );
  assert.equal(isTelegramBlockedError({ response: { body: { error_code: 429 } } }), false);
  assert.equal(isTelegramBlockedError(new Error('ETIMEDOUT')), false);
});
