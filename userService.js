// userService.js
import { getDB } from './db.js';

/**
 * Генерация уникального промокода
 */
function generatePromoCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/**
 * Создать или получить пользователя
 */
async function getOrCreateUser(userId, username = null) {
  try {
    const db = getDB();
    const usersCollection = db.collection('users');

    // Проверяем, существует ли пользователь
    let user = await usersCollection.findOne({ userId: String(userId) });

    if (user) {
      console.log(`👤 Пользователь найден: ${userId}`);
      return user;
    }

    // Создаём нового пользователя
    const newUser = {
      userId: String(userId),
      username: username || `user${userId}`,
      promoCode: generatePromoCode(),
      invitedCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await usersCollection.insertOne(newUser);
    console.log(`✅ Новый пользователь создан: ${userId}, промокод: ${newUser.promoCode}`);

    return newUser;
  } catch (error) {
    console.error('❌ Ошибка в getOrCreateUser:', error);
    throw error;
  }
}

/**
 * Получить пользователя по ID
 */
async function getUserById(userId) {
  try {
    const db = getDB();
    const usersCollection = db.collection('users');
    
    const user = await usersCollection.findOne({ userId: String(userId) });
    return user;
  } catch (error) {
    console.error('❌ Ошибка в getUserById:', error);
    throw error;
  }
}

/**
 * Получить пользователя по промокоду
 */
async function getUserByPromoCode(promoCode) {
  try {
    const db = getDB();
    const usersCollection = db.collection('users');
    
    const user = await usersCollection.findOne({ promoCode: promoCode.toUpperCase() });
    return user;
  } catch (error) {
    console.error('❌ Ошибка в getUserByPromoCode:', error);
    throw error;
  }
}

/**
 * Увеличить счётчик рефералов
 */
async function incrementReferralCount(promoCode) {
  try {
    const db = getDB();
    const usersCollection = db.collection('users');

    const result = await usersCollection.updateOne(
      { promoCode: promoCode.toUpperCase() },
      { 
        $inc: { invitedCount: 1 },
        $set: { updatedAt: new Date() }
      }
    );

    if (result.modifiedCount > 0) {
      console.log(`🎉 Реферал засчитан для промокода: ${promoCode}`);
      return true;
    }

    console.log(`⚠️ Промокод не найден: ${promoCode}`);
    return false;
  } catch (error) {
    console.error('❌ Ошибка в incrementReferralCount:', error);
    throw error;
  }
}

/**
 * Обновить username пользователя
 */
async function updateUsername(userId, username) {
  try {
    const db = getDB();
    const usersCollection = db.collection('users');

    await usersCollection.updateOne(
      { userId: String(userId) },
      { 
        $set: { 
          username: username,
          updatedAt: new Date()
        }
      }
    );

    console.log(`✏️ Username обновлён для ${userId}: ${username}`);
  } catch (error) {
    console.error('❌ Ошибка в updateUsername:', error);
    throw error;
  }
}

export {
  getOrCreateUser,
  getUserById,
  getUserByPromoCode,
  incrementReferralCount,
  updateUsername,
  generatePromoCode
};
