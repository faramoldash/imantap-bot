// utils/userLock.js
// Per-user async lock: сериализует конкурентные вызовы для одного userId.
// Предотвращает race condition при параллельных sync-запросах (double XP).

const _syncLocks = new Map();

/**
 * Выполняет fn эксклюзивно для данного userId.
 * Если уже выполняется другой вызов для того же userId — ждёт его завершения.
 *
 * @param {number|string} userId
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
export function withUserLock(userId, fn) {
  const key = String(userId);
  const prev = _syncLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn);
  // guard — заглушённая версия для lock-цепочки: ошибки не всплывают,
  // следующий вызов в очереди всегда запустится.
  const guard = next.catch(() => {});
  _syncLocks.set(key, guard);
  // Чистим запись только если guard всё ещё последний в очереди
  guard.then(() => {
    if (_syncLocks.get(key) === guard) _syncLocks.delete(key);
  });
  // Возвращаем next с оригинальным rejection — caller сам решает как обработать
  return next;
}
