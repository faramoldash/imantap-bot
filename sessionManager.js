// sessionManager.js
// Управление сессиями пользователей для многошагового онбординга

const sessions = new Map();

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 часа — достаточно для онбординга
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // чистка раз в час

/**
 * Удалить сессии, которые не обновлялись дольше SESSION_TTL_MS.
 * Вызывается автоматически по таймеру.
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  let removed = 0;
  for (const [userId, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(userId);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`🧹 SessionManager: удалено ${removed} устаревших сессий, осталось ${sessions.size}`);
  }
}

// Запускаем периодическую чистку
const cleanupTimer = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
// Не блокируем завершение процесса Node.js
if (cleanupTimer.unref) cleanupTimer.unref();

/**
 * Создать или получить сессию пользователя
 */
export function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      state: null,
      data: {},
      lastActivity: Date.now()
    });
  } else {
    sessions.get(userId).lastActivity = Date.now();
  }
  return sessions.get(userId);
}

/**
 * Установить состояние пользователя
 */
export function setState(userId, state) {
  const session = getSession(userId);
  session.state = state;
  console.log(`📌 User ${userId} -> State: ${state}`);
}

/**
 * Получить состояние пользователя
 */
export function getState(userId) {
  const session = getSession(userId);
  return session.state;
}

/**
 * Сохранить данные в сессию
 */
export function setSessionData(userId, key, value) {
  const session = getSession(userId);
  session.data[key] = value;
}

/**
 * Получить данные из сессии
 */
export function getSessionData(userId, key) {
  const session = getSession(userId);
  return session.data[key];
}

/**
 * Очистить сессию
 */
export function clearSession(userId) {
  sessions.delete(userId);
  console.log(`🗑️ Session cleared for user ${userId}`);
}
