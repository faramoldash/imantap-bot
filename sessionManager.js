// sessionManager.js
// Управление сессиями пользователей для многошагового онбординга

const sessions = new Map();

/**
 * Создать или получить сессию пользователя
 */
export function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      state: null,
      data: {}
    });
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