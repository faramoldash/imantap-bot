// adminService.js
// Управление админами и менеджерами

import { getDB } from './db.js';

/**
 * Безопасно получить Telegram ID главного админа из env.
 */
export function getMainAdminId() {
  const raw = process.env.MAIN_ADMIN_ID;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const parsed = parseInt(String(raw).trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Проверить, является ли пользователь главным админом (MAIN_ADMIN_ID).
 */
export function isMainAdmin(telegramId) {
  const mainAdminId = getMainAdminId();
  if (mainAdminId === null) return false;
  const tid = parseInt(telegramId, 10);
  return Number.isInteger(tid) && tid === mainAdminId;
}

/**
 * Получить список всех админов/менеджеров
 */
export async function getAdmins(deps = {}) {
  const mainAdminId = getMainAdminId();

  const db = deps.db || getDB();
  const admins = db.collection('admins');

  const adminList = await admins.find({}).toArray();
  const managerIds = adminList
    .map(a => parseInt(a.telegramId, 10))
    .filter(id => Number.isInteger(id) && id > 0);

  // Всегда включаем главного админа в список без дубликатов
  const uniqueIds = [...new Set(managerIds)];
  if (mainAdminId !== null && !uniqueIds.includes(mainAdminId)) {
    uniqueIds.unshift(mainAdminId);
  }

  return uniqueIds;
}

/**
 * Проверить является ли пользователь админом или менеджером
 */
export async function isAdmin(telegramId, deps = {}) {
  const tid = parseInt(telegramId, 10);
  if (!Number.isInteger(tid) || tid <= 0) {
    return false;
  }

  // Главный админ всегда имеет доступ
  if (isMainAdmin(tid)) {
    return true;
  }

  const db = deps.db || getDB();
  const admins = db.collection('admins');

  const admin = await admins.findOne({ telegramId: tid });
  return !!admin;
}

/**
 * Добавить менеджера (только главный админ)
 */
export async function addManager(telegramId, addedBy, username = null, deps = {}) {
  if (!isMainAdmin(addedBy)) {
    return { success: false, message: 'Только главный админ может добавлять менеджеров' };
  }

  const tid = parseInt(telegramId, 10);
  if (!Number.isInteger(tid) || tid <= 0) {
    return { success: false, message: 'Некорректный Telegram ID' };
  }

  if (isMainAdmin(tid)) {
    return { success: false, message: 'Главный админ уже имеет все права' };
  }

  const db = deps.db || getDB();
  const admins = db.collection('admins');

  // Проверяем что не существует
  const existing = await admins.findOne({ telegramId: tid });
  if (existing) {
    return { success: false, message: 'Менеджер уже добавлен' };
  }

  await admins.insertOne({
    telegramId: tid,
    username,
    role: 'manager',
    addedBy: parseInt(addedBy, 10),
    addedAt: new Date()
  });

  console.log(`✅ Менеджер добавлен: ${tid} by ${addedBy}`);
  return { success: true, message: 'Менеджер успешно добавлен' };
}

/**
 * Удалить менеджера (только главный админ)
 */
export async function removeManager(telegramId, removedBy = null, deps = {}) {
  if (removedBy !== null && !isMainAdmin(removedBy)) {
    return { success: false, message: 'Только главный админ может удалять менеджеров' };
  }

  const tid = parseInt(telegramId, 10);
  if (!Number.isInteger(tid) || tid <= 0) {
    return { success: false, message: 'Некорректный Telegram ID' };
  }

  // Нельзя удалить главного админа
  if (isMainAdmin(tid)) {
    return { success: false, message: 'Нельзя удалить главного админа' };
  }

  const db = deps.db || getDB();
  const admins = db.collection('admins');

  const result = await admins.deleteOne({ telegramId: tid });

  if (result.deletedCount === 0) {
    return { success: false, message: 'Менеджер не найден' };
  }

  console.log(`🗑️ Менеджер удалён: ${tid}`);
  return { success: true, message: 'Менеджер удалён' };
}

/**
 * Получить список менеджеров для отображения
 */
export async function listManagers(deps = {}) {
  const db = deps.db || getDB();
  const admins = db.collection('admins');

  const managers = await admins.find({}).toArray();
  return managers;
}