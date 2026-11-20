// config.js — все ключевые даты сезона в одном месте.
// При смене года (Рамадан 2027 и т.д.) обновляй только этот файл.

export const RAMADAN_START_DATE    = '2026-02-19'; // начало Рамадана
export const PREPARATION_START_DATE = '2026-02-09'; // начало подготовки (10 дней до Рамадана)
export const FIRST_TARAWEEH_DATE   = '2026-02-18'; // первый таравих-намаз
export const EID_AL_FITR_DATE      = '2026-03-20'; // Ораза айт
export const SHAWWAL_START_DATE    = '2026-03-21'; // начало Шавваля
export const SHAWWAL_END_DATE      = '2026-04-19'; // конец периода 6 постов Шавваля

// Сколько дней в каждой фазе
export const PREPARATION_DAYS = 10;
export const RAMADAN_DAYS     = 29;
export const SHAWWAL_FASTS    = 6;

// Готовые Date-объекты для серверных сравнений (UTC+5 / Asia/Almaty полночь).
// Сервер работает в UTC, поэтому используем явное смещение +05:00.
export const RAMADAN_START_MS     = new Date(RAMADAN_START_DATE     + 'T00:00:00+05:00').getTime();
export const PREPARATION_START_MS = new Date(PREPARATION_START_DATE + 'T00:00:00+05:00').getTime();
export const FIRST_TARAWEEH_MS    = new Date(FIRST_TARAWEEH_DATE    + 'T00:00:00+05:00').getTime();
export const EID_AL_FITR_MS       = new Date(EID_AL_FITR_DATE       + 'T23:59:59+05:00').getTime();
export const SHAWWAL_START_MS     = new Date(SHAWWAL_START_DATE     + 'T00:00:00+05:00').getTime();
export const SHAWWAL_END_MS       = new Date(SHAWWAL_END_DATE       + 'T23:59:59+05:00').getTime();

// Безопасные хелперы для формирования Telegram-диплинков (без "undefined" в URL)
export const DEFAULT_BOT_USERNAME = 'imantap_bot';

export function getBotUsername() {
  const raw = process.env.BOT_USERNAME?.trim().replace(/^@+/, '');
  return raw || DEFAULT_BOT_USERNAME;
}

export function getMiniAppDeepLink() {
  const botUsername = getBotUsername();
  const miniAppName = process.env.MINI_APP_NAME?.trim().replace(/^\/+|\/+$/g, '');
  if (miniAppName) {
    return `https://t.me/${botUsername}/${miniAppName}`;
  }
  return `https://t.me/${botUsername}`;
}
