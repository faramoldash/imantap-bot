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
export async function getOrCreateUser(userId, username = null) {
  const db = getDB();
  const users = db.collection('users');

  let user = await users.findOne({ userId });

  if (!user) {
    const promoCode = generatePromoCode();
    
    const newUser = {
      userId,
      username: username ? `@${username}` : null,
      promoCode,
      invitedCount: 0,
      
      // Новые поля онбординга
      name: null,
      phoneNumber: null,
      location: {
        city: null,
        country: null,
        latitude: null,
        longitude: null
      },
      timezone: null,
      
      // Реферальная система
      referredBy: null,           // Кто пригласил
      usedPromoCode: null,         // Какой промокод использовал
      
      // Оплата
      paymentStatus: 'unpaid',     // unpaid | pending | paid | rejected
      paidAmount: null,            // 2490 или 1990
      hasDiscount: false,
      receiptPhotoId: null,
      receiptMessageId: null,
      paymentDate: null,
      
      // Доступ
      accessType: null,            // null | demo | full
      demoExpiresAt: null,
      
      // Прогресс (как было)
      progress: {},
      memorizedNames: [],
      completedJuzs: [],
      quranKhatams: 0,
      completedTasks: [],
      deletedPredefinedTasks: [],
      customTasks: [],
      quranGoal: 30,
      dailyQuranGoal: 5,
      dailyCharityGoal: 1000,
      language: 'kk',
      xp: 0,
      unlockedBadges: [],
      hasRedeemedReferral: false,
      
      // Мета
      onboardingCompleted: false,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await users.insertOne(newUser);
    console.log(`✅ Создан новый пользователь: ${userId}`);
    
    user = newUser;
  }

  return user;
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

// =====================================================
// 🔐 ФУНКЦИИ ДЛЯ ОНБОРДИНГА И ОПЛАТЫ
// =====================================================

/**
 * Обновить онбординг данные пользователя
 */
export async function updateUserOnboarding(userId, data) {
  const db = getDB();
  const users = db.collection('users');
  
  const updateData = {
    ...data,
    updatedAt: new Date()
  };
  
  const result = await users.updateOne(
    { userId },
    { $set: updateData }
  );
  
  return result.modifiedCount > 0;
}

/**
 * Проверить промокод на валидность
 */
export async function checkPromoCode(promoCode, userId) {
  const db = getDB();
  const users = db.collection('users');
  const usedPromoCodes = db.collection('used_promocodes');
  
  // Проверяем существует ли такой промокод
  const owner = await users.findOne({ promoCode: promoCode.toUpperCase() });
  
  if (!owner) {
    return { valid: false, reason: 'not_found' };
  }
  
  // Проверяем что это не свой промокод
  if (owner.userId === userId) {
    return { valid: false, reason: 'own_code' };
  }
  
  // Проверяем что промокод не использован
  const alreadyUsed = await usedPromoCodes.findOne({ promoCode: promoCode.toUpperCase() });
  
  if (alreadyUsed) {
    return { valid: false, reason: 'already_used' };
  }
  
  // Проверяем что владелец промокода оплатил
  if (owner.paymentStatus !== 'paid') {
    return { valid: false, reason: 'owner_not_paid' };
  }
  
  return { valid: true, owner };
}

/**
 * Отметить промокод как использованный
 */
export async function markPromoCodeAsUsed(promoCode, userId) {
  const db = getDB();
  const usedPromoCodes = db.collection('used_promocodes');
  
  await usedPromoCodes.insertOne({
    promoCode: promoCode.toUpperCase(),
    usedBy: userId,
    usedAt: new Date()
  });
  
  console.log(`✅ Промокод ${promoCode} использован пользователем ${userId}`);
}

/**
 * Обновить статус оплаты
 */
export async function updatePaymentStatus(userId, status, additionalData = {}) {
  const db = getDB();
  const users = db.collection('users');
  
  const updateData = {
    paymentStatus: status,
    updatedAt: new Date(),
    ...additionalData
  };
  
  const result = await users.updateOne(
    { userId },
    { $set: updateData }
  );
  
  console.log(`💳 Статус оплаты пользователя ${userId}: ${status}`);
  
  return result.modifiedCount > 0;
}

/**
 * Подтвердить оплату
 */
export async function approvePayment(userId) {
  const db = getDB();
  const users = db.collection('users');
  
  const user = await users.findOne({ userId });
  
  const updateData = {
    paymentStatus: 'paid',
    accessType: 'full',
    paymentDate: new Date(),
    onboardingCompleted: true,
    updatedAt: new Date()
  };
  
  await users.updateOne({ userId }, { $set: updateData });
  
  // Если был реферал - увеличиваем счётчик
  if (user.referredBy) {
    await incrementReferralCount(user.referredBy);
  }
  
  console.log(`✅ Оплата подтверждена для пользователя ${userId}`);
  
  return true;
}

/**
 * Отклонить оплату и дать демо-доступ
 */
export async function rejectPayment(userId) {
  const db = getDB();
  const users = db.collection('users');
  
  const demoExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // +1 день
  
  const updateData = {
    paymentStatus: 'rejected',
    accessType: 'demo',
    demoExpiresAt,
    updatedAt: new Date()
  };
  
  await users.updateOne({ userId }, { $set: updateData });
  
  console.log(`❌ Оплата отклонена для пользователя ${userId}. Дан демо-доступ до ${demoExpiresAt}`);
  
  return true;
}

/**
 * Получить всех пользователей с pending статусом оплаты
 */
export async function getPendingPayments() {
  const db = getDB();
  const users = db.collection('users');
  
  return await users.find({ paymentStatus: 'pending' }).toArray();
}

/**
 * Проверить истёк ли демо-доступ
 */
export async function checkDemoExpiration(userId) {
  const db = getDB();
  const users = db.collection('users');
  
  const user = await users.findOne({ userId });
  
  if (!user || user.accessType !== 'demo') {
    return false;
  }
  
  const expiresAt = new Date(user.demoExpiresAt);
  const isExpired = expiresAt < new Date();
  
  return isExpired;
}

/**
 * Получить информацию о доступе пользователя
 */
export async function getUserAccess(userId) {
  const db = getDB();
  const users = db.collection('users');
  
  const user = await users.findOne({ userId });
  
  if (!user) {
    return { hasAccess: false, type: null, reason: 'user_not_found' };
  }
  
  // Полный доступ
  if (user.paymentStatus === 'paid') {
    return { 
      hasAccess: true, 
      type: 'full',
      onboardingCompleted: user.onboardingCompleted 
    };
  }
  
  // Демо доступ
  if (user.accessType === 'demo') {
    const expiresAt = new Date(user.demoExpiresAt);
    
    if (expiresAt > new Date()) {
      return { 
        hasAccess: true, 
        type: 'demo',
        expiresAt: expiresAt.toISOString() 
      };
    } else {
      return { 
        hasAccess: false, 
        type: null, 
        reason: 'demo_expired' 
      };
    }
  }
  
  // Нет доступа
  return { 
    hasAccess: false, 
    type: null, 
    reason: 'not_paid',
    onboardingCompleted: user.onboardingCompleted 
  };
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