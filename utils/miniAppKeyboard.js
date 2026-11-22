// utils/miniAppKeyboard.js
// Единые хелперы для кнопок запуска Telegram Mini App.
// ВАЖНО (ограничение Telegram Bot API):
// - Кнопки web_app внутри Reply Keyboard (reply_markup.keyboard) ВСЕГДА открывают Mini App
//   с пустым initData ("") и без объекта user, поэтому бэкенд отклоняет запросы с 401.
// - Валидный подписанный initData (#tgWebAppData) Telegram передаёт ТОЛЬКО при открытии через:
//   1) Inline Keyboard кнопку (reply_markup.inline_keyboard с web_app: { url }),
//   2) Нативную Menu Button (setChatMenuButton),
//   3) Direct Link Mini App (t.me/<bot>/<app>).

const DEFAULT_MINI_APP_URL = 'https://imantap-production-6776.up.railway.app';

/**
 * Нормализует URL Mini App: убирает пробелы и устаревший query-параметр tgWebAppStartParam,
 * чтобы Telegram открывал страницу напрямую без редиректов и потери #tgWebAppData.
 */
export function normalizeMiniAppUrl(rawUrl) {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  const candidate = trimmed || DEFAULT_MINI_APP_URL;

  try {
    const parsed = new URL(candidate);
    parsed.searchParams.delete('tgWebAppStartParam');
    // Убираем пустой хвостовой слеш только для корня, если его не было в исходнике
    const clean = parsed.toString();
    return clean.endsWith('/') && !candidate.endsWith('/') ? clean.slice(0, -1) : clean;
  } catch {
    return candidate.split('?')[0];
  }
}

/**
 * Нативная inline-кнопка web_app — единственный тип кнопки в сообщении,
 * который гарантированно передаёт подписанный Telegram initData.
 */
export function buildOpenAppInlineMarkup(miniAppUrl, text = '📱 ImanTap ашу') {
  return {
    inline_keyboard: [[
      {
        text,
        web_app: { url: normalizeMiniAppUrl(miniAppUrl) },
      },
    ]],
  };
}

/**
 * Постоянные Reply-клавиатуры — СТРОГО без web_app-кнопок.
 * Текстовая кнопка '📱 ImanTap ашу' обрабатывается в bot.on('message')
 * и мгновенно присылает inline-кнопку web_app с валидным initData.
 */
export const MAIN_REPLY_KEYBOARD = {
  keyboard: [
    ['📱 ImanTap ашу'],
    ['⚙️ Баптаулар', '📊 XP'],
    ['📈 Статистика', '🎁 Менің промокодым'],
  ],
  resize_keyboard: true,
};

export const DEMO_REPLY_KEYBOARD = {
  keyboard: [
    ['📱 ImanTap ашу'],
    [{ text: '💳 Толық нұсқаны сатып алу' }],
  ],
  resize_keyboard: true,
};

export const REJECT_DEMO_REPLY_KEYBOARD = {
  keyboard: [
    ['📱 ImanTap ашу'],
    [{ text: '💳 Қайта төлем жасау' }],
  ],
  resize_keyboard: true,
};

export const NO_GEO_REPLY_KEYBOARD = {
  keyboard: [
    ['⚙️ Баптаулар'],
    ['📱 ImanTap ашу'],
    ['📈 Статистика', '🎁 Менің промокодым'],
  ],
  resize_keyboard: true,
};
