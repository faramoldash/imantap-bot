// adminService.js
// Управление админами и менеджерами

import { getDB } from './db.js';

/**
 * Получить список всех админов/менеджеров
 */
export async function getAdmins() {
  const MAIN_ADMIN = parseInt(process.env.MAIN_ADMIN_ID);
  
  const db = getDB();
  const admins = db.collection('admins');
  
  const adminList = await admins.find({}).toArray();
  const managerIds = adminList.map(a => a.telegramId);
  
  // Всегда включаем главного админа в список
  if (MAIN_ADMIN && !managerIds.includes(MAIN_ADMIN)) {
    managerIds.unshift(MAIN_ADMIN); // Добавляем в начало
  }
  
  return managerIds;
}

/**
 * Проверить является ли пользователь админом
 */
export async function isAdmin(telegramId) {
  const MAIN_ADMIN = parseInt(process.env.MAIN_ADMIN_ID);
  
  // Главный админ всегда имеет доступ
  if (telegramId === MAIN_ADMIN) {
    return true;
  }
  
  const db = getDB();
  const admins = db.collection('admins');
  
  const admin = await admins.findOne({ telegramId });
  return !!admin;
}

/**
 * Добавить менеджера
 */
export async function addManager(telegramId, addedBy, username = null) {
  const db = getDB();
  const admins = db.collection('admins');
  
  // Проверяем что не существует
  const existing = await admins.findOne({ telegramId });
  if (existing) {
    return { success: false, message: 'Менеджер уже добавлен' };
  }
  
  await admins.insertOne({
    telegramId,
    username,
    role: 'manager',
    addedBy,
    addedAt: new Date()
  });
  
  console.log(`✅ Менеджер добавлен: ${telegramId} by ${addedBy}`);
  return { success: true, message: 'Менеджер успешно добавлен' };
}

/**
 * Удалить менеджера
 */
export async function removeManager(telegramId) {
  const MAIN_ADMIN = parseInt(process.env.MAIN_ADMIN_ID);
  
  // Нельзя удалить главного админа
  if (telegramId === MAIN_ADMIN) {
    return { success: false, message: 'Нельзя удалить главного админа' };
  }
  
  const db = getDB();
  const admins = db.collection('admins');
  
  const result = await admins.deleteOne({ telegramId });
  
  if (result.deletedCount === 0) {
    return { success: false, message: 'Менеджер не найден' };
  }
  
  console.log(`🗑️ Менеджер удалён: ${telegramId}`);
  return { success: true, message: 'Менеджер удалён' };
}

/**
 * Получить список менеджеров для отображения
 */
export async function listManagers() {
  const db = getDB();
  const admins = db.collection('admins');
  
  const managers = await admins.find({}).toArray();
  return managers;
}