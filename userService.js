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
    const users = db.collection('users');

    // Проверяем существует ли пользователь
    let user = await users.findOne({ userId: parseInt(userId) });

    if (user) {
      return user;
    }

    // Создаём нового пользователя с полной структурой
    const promoCode = generatePromoCode();
    const newUser = {
      userId: parseInt(userId),
      username: username || null,
      promoCode: promoCode,
      invitedCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      
      // Данные прогресса из Mini App
      name: username || `User${userId}`,
      photoUrl: null,
      startDate: new Date().toISOString().split('T')[0],
      registrationDate: new Date().toISOString().split('T')[0],
      progress: {}, // Record<number, DayProgress>
      memorizedNames: [],
      completedJuzs: [],
      quranKhatams: 0,
      completedTasks: [],
      deletedPredefinedTasks: [],
      customTasks: [],
      quranGoal: 30,
      dailyQuranGoal: 4,
      dailyCharityGoal: 100,
      language: 'kk',
      xp: 0,
      hasRedeemedReferral: false,
      unlockedBadges: []
    };

    await users.insertOne(newUser);
    console.log(`✅ Новый пользователь создан: ${userId}, промокод: ${promoCode}`);

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
    
    const user = await usersCollection.findOne({ userId: parseInt(userId) });
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

/**
 * Обновить полный прогресс пользователя
 */
async function updateUserProgress(userId, progressData) {
  try {
    const db = getDB();
    const usersCollection = db.collection('users');

    const result = await usersCollection.updateOne(
      { userId: parseInt(userId) },
      {
        $set: {
          ...progressData,
          updatedAt: new Date()
        }
      }
    );

    if (result.modifiedCount > 0) {
      console.log(`✅ Прогресс обновлён для пользователя: ${userId}`);
      return true;
    }

    console.log(`⚠️ Пользователь не найден: ${userId}`);
    return false;
  } catch (error) {
    console.error('❌ Ошибка в updateUserProgress:', error);
    throw error;
  }
}


/**
 * Получить полные данные пользователя для Mini App
 */
async function getUserFullData(userId) {
  try {
    const db = getDB();
    const usersCollection = db.collection('users');

    const user = await usersCollection.findOne({ userId: parseInt(userId) });
    
    if (!user) {
      return null;
    }

    // Возвращаем все данные в формате для Mini App
    return {
      userId: user.userId,
      username: user.username,
      promoCode: user.promoCode,
      invitedCount: user.invitedCount,
      name: user.name,
      photoUrl: user.photoUrl,
      startDate: user.startDate,
      registrationDate: user.registrationDate,
      progress: user.progress || {},
      memorizedNames: user.memorizedNames || [],
      completedJuzs: user.completedJuzs || [],
      quranKhatams: user.quranKhatams || 0,
      completedTasks: user.completedTasks || [],
      deletedPredefinedTasks: user.deletedPredefinedTasks || [],
      customTasks: user.customTasks || [],
      quranGoal: user.quranGoal || 30,
      dailyQuranGoal: user.dailyQuranGoal || 4,
      dailyCharityGoal: user.dailyCharityGoal || 100,
      language: user.language || 'kk',
      xp: user.xp || 0,
      referralCount: user.invitedCount,
      myPromoCode: user.promoCode,
      hasRedeemedReferral: user.hasRedeemedReferral || false,
      unlockedBadges: user.unlockedBadges || []
    };
  } catch (error) {
    console.error('❌ Ошибка в getUserFullData:', error);
    throw error;
  }
}

export {
  getOrCreateUser,
  getUserById,
  getUserByPromoCode,
  incrementReferralCount,
  updateUsername,
  generatePromoCode,
  updateUserProgress,
  getUserFullData
};