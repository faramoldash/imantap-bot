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
        longitude: null,
        timezone: null
      },

      prayerTimes: { // ✅ ДОБАВЬТЕ новое поле
        fajr: null,
        sunrise: null,
        dhuhr: null,
        asr: null,
        maghrib: null,
        isha: null,
        lastUpdated: null
      },
      notificationSettings: { // ✅ ДОБАВЬТЕ настройки уведомлений
        ramadanReminders: true,
        reminderMinutesBefore: 30
      },
      
      // Реферальная система
      referredBy: null,
      usedPromoCode: null,
      
      // Оплата
      paymentStatus: 'unpaid',
      paidAmount: null,
      hasDiscount: false,
      receiptPhotoId: null,
      receiptMessageId: null,
      paymentDate: null,
      
      // Доступ
      accessType: null,
      demoExpiresAt: null,
      
      // Прогресс (как было)
      progress: {},
      preparationProgress: {},
      basicProgress: {},
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
    
    // Сначала найдём пользователя по промокоду
    const user = await usersCollection.findOne({ promoCode: promoCode.toUpperCase() });
    
    const result = await usersCollection.updateOne(
      { promoCode: promoCode.toUpperCase() },
      { 
        $inc: { invitedCount: 1 },
        $set: { updatedAt: new Date() }
      }
    );
    
    if (result.modifiedCount > 0 && user) {
      await checkAndUnlockBadges(user.userId); // ← ДОБАВИТЬ ЭТУ СТРОКУ
      console.log(`✅ Увеличен счётчик рефералов для промокода: ${promoCode}`);
      return true;
    }
    
    console.log(`❌ Не найден пользователь с промокодом: ${promoCode}`);
    return false;
  } catch (error) {
    console.error('❌ Ошибка incrementReferralCount:', error);
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
    
    // ✅ Создаем объект только с теми полями, которые пришли
    const updateFields = {
      updatedAt: new Date()
    };
    
    // ✅ Добавляем только те поля, которые есть в progressData
    if (progressData.name !== undefined) updateFields.name = progressData.name;
    if (progressData.username !== undefined) updateFields.username = progressData.username;
    if (progressData.photoUrl !== undefined) updateFields.photoUrl = progressData.photoUrl;
    if (progressData.registrationDate !== undefined) updateFields.registrationDate = progressData.registrationDate;
    if (progressData.progress !== undefined) updateFields.progress = progressData.progress;
    if (progressData.preparationProgress !== undefined) updateFields.preparationProgress = progressData.preparationProgress;
    if (progressData.basicProgress !== undefined) updateFields.basicProgress = progressData.basicProgress;  // ✅ ДОБАВЛЕНО!
    if (progressData.memorizedNames !== undefined) updateFields.memorizedNames = progressData.memorizedNames;
    if (progressData.completedJuzs !== undefined) updateFields.completedJuzs = progressData.completedJuzs;
    if (progressData.quranKhatams !== undefined) updateFields.quranKhatams = progressData.quranKhatams;
    if (progressData.completedTasks !== undefined) updateFields.completedTasks = progressData.completedTasks;
    if (progressData.deletedPredefinedTasks !== undefined) updateFields.deletedPredefinedTasks = progressData.deletedPredefinedTasks;
    if (progressData.customTasks !== undefined) updateFields.customTasks = progressData.customTasks;
    if (progressData.quranGoal !== undefined) updateFields.quranGoal = progressData.quranGoal;
    if (progressData.dailyQuranGoal !== undefined) updateFields.dailyQuranGoal = progressData.dailyQuranGoal;
    if (progressData.dailyCharityGoal !== undefined) updateFields.dailyCharityGoal = progressData.dailyCharityGoal;
    if (progressData.language !== undefined) updateFields.language = progressData.language;
    if (progressData.xp !== undefined) updateFields.xp = progressData.xp;
    if (progressData.hasRedeemedReferral !== undefined) updateFields.hasRedeemedReferral = progressData.hasRedeemedReferral;
    if (progressData.unlockedBadges !== undefined) updateFields.unlockedBadges = progressData.unlockedBadges;
    if (progressData.currentStreak !== undefined) updateFields.currentStreak = progressData.currentStreak;
    if (progressData.longestStreak !== undefined) updateFields.longestStreak = progressData.longestStreak;
    if (progressData.lastActiveDate !== undefined) updateFields.lastActiveDate = progressData.lastActiveDate;
    
    const result = await usersCollection.updateOne(
      { userId: parseInt(userId) },
      { $set: updateFields }
    );
    
    if (result.modifiedCount > 0) {
      console.log('✅ Прогресс обновлен для userId:', userId);
      return true;
    }
    
    console.log('⚠️ Прогресс не изменился для userId:', userId);
    return false;
  } catch (error) {
    console.error('❌ updateUserProgress ошибка:', error);
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
    
    if (!user) return null;
    
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
      preparationProgress: user.preparationProgress || {},  // ✅ ДОБАВЬТЕ
      basicProgress: user.basicProgress || {},  // ✅ ДОБАВЬТЕ
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
      unlockedBadges: user.unlockedBadges || [],
      currentStreak: user.currentStreak || 0,  // ✅ ДОБАВЬТЕ
      longestStreak: user.longestStreak || 0,  // ✅ ДОБАВЬТЕ
      lastActiveDate: user.lastActiveDate || ''  // ✅ ДОБАВЬТЕ
    };
  } catch (error) {
    console.error('❌ getUserFullData ошибка:', error);
    throw error;
  }
}

// =====================================================
// 🔐 ФУНКЦИИ ДЛЯ ОНБОРДИНГА И ОПЛАТЫ
// =====================================================

async function updateUserOnboarding(userId, data) {
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

async function checkPromoCode(promoCode, userId) {
  const db = getDB();
  const users = db.collection('users');
  const usedPromoCodes = db.collection('used_promocodes');
  
  const owner = await users.findOne({ promoCode: promoCode.toUpperCase() });
  
  if (!owner) {
    return { valid: false, reason: 'not_found' };
  }
  
  if (owner.userId === userId) {
    return { valid: false, reason: 'own_code' };
  }
  
  const alreadyUsed = await usedPromoCodes.findOne({ promoCode: promoCode.toUpperCase() });
  
  if (alreadyUsed) {
    return { valid: false, reason: 'already_used' };
  }
  
  if (owner.paymentStatus !== 'paid') {
    return { valid: false, reason: 'owner_not_paid' };
  }
  
  return { valid: true, owner };
}

async function markPromoCodeAsUsed(promoCode, userId) {
  const db = getDB();
  const usedPromoCodes = db.collection('used_promocodes');
  
  await usedPromoCodes.insertOne({
    promoCode: promoCode.toUpperCase(),
    usedBy: userId,
    usedAt: new Date()
  });
  
  console.log(`✅ Промокод ${promoCode} использован пользователем ${userId}`);
}

async function updatePaymentStatus(userId, status, additionalData = {}) {
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

async function approvePayment(userId) {
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
  
  if (user.referredBy) {
    await incrementReferralCount(user.referredBy);
  }
  
  console.log(`✅ Оплата подтверждена для пользователя ${userId}`);
  
  return true;
}

async function rejectPayment(userId) {
  const db = getDB();
  const users = db.collection('users');
  
  const demoExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  
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

async function getPendingPayments() {
  const db = getDB();
  const users = db.collection('users');
  
  return await users.find({ paymentStatus: 'pending' }).toArray();
}

async function checkDemoExpiration(userId) {
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
 * Получить информацию о доступе пользователя (для Mini App)
 */
async function getUserAccess(userId) {
  const MAIN_ADMIN = parseInt(process.env.MAIN_ADMIN_ID);
  
  // 🔥 АДМИН ВСЕГДА ИМЕЕТ ДОСТУП
  if (userId === MAIN_ADMIN) {
    return {
      hasAccess: true,
      paymentStatus: 'paid',
      reason: 'admin_access'
    };
  }
  
  const db = getDB();
  const users = db.collection('users');
  
  const user = await users.findOne({ userId });
  
  // Пользователь не найден
  if (!user) {
    return { 
      hasAccess: false, 
      paymentStatus: 'unpaid',
      reason: 'user_not_found' 
    };
  }
  
  // 🔥 ДЕМО-ДОСТУП (ПРОВЕРЯЕМ ПЕРВЫМ!)
  if (user.accessType === 'demo' && user.demoExpiresAt) {
    const expiresAt = new Date(user.demoExpiresAt);
    
    if (expiresAt > new Date()) {
      return { 
        hasAccess: true, 
        paymentStatus: 'demo',
        demoExpires: expiresAt.toISOString()
      };
    } else {
      // Демо истекло
      return { 
        hasAccess: false, 
        paymentStatus: 'unpaid',
        reason: 'demo_expired' 
      };
    }
  }
  
  // Оплата подтверждена
  if (user.paymentStatus === 'paid') {
    return { 
      hasAccess: true, 
      paymentStatus: 'paid'
    };
  }
  
  // Платёж на проверке
  if (user.paymentStatus === 'pending') {
    return { 
      hasAccess: false, 
      paymentStatus: 'pending',
      reason: 'payment_pending'
    };
  }
  
  // Не оплачено
  return { 
    hasAccess: false, 
    paymentStatus: 'unpaid',
    reason: 'not_paid'
  };
}

/**
 * Добавить XP пользователю
 */
async function addUserXP(userId, amount, reason = '') {
  try {
    const db = getDB();
    const users = db.collection('users');
    
    const result = await users.updateOne(
      { userId: parseInt(userId) },
      { 
        $inc: { xp: amount },
        $set: { updatedAt: new Date() }
      }
    );
    
    if (result.modifiedCount > 0) {
      await checkAndUnlockBadges(userId);
      console.log(`✅ Добавлено ${amount} XP для userId ${userId}. Причина: ${reason}`);
      return true;
    }
    
    console.log(`⚠️ Не удалось добавить XP для userId ${userId}`);
    return false;
  } catch (error) {
    console.error('❌ addUserXP ошибка:', error);
    throw error;
  }
}

/**
 * Получить глобальный лидерборд (топ пользователей по XP)
 */
async function getGlobalLeaderboard(limit = 50) {
  try {
    const db = getDB();
    const users = db.collection('users');
    
    const leaderboard = await users.find({
      paymentStatus: { $in: ['paid', 'demo'] }, // Только активные пользователи
      xp: { $gt: 0 } // У кого есть XP
    })
    .sort({ xp: -1 }) // Сортировка по убыванию XP
    .limit(limit)
    .project({
      userId: 1,
      username: 1,
      name: 1,
      photoUrl: 1,
      xp: 1,
      currentStreak: 1,
      unlockedBadges: 1,
      invitedCount: 1
    })
    .toArray();
    
    return leaderboard;
  } catch (error) {
    console.error('❌ getGlobalLeaderboard ошибка:', error);
    throw error;
  }
}

/**
 * Получить рейтинг пользователя (его позицию в лидерборде)
 */
async function getUserRank(userId) {
  try {
    const db = getDB();
    const users = db.collection('users');
    
    const user = await users.findOne({ userId: parseInt(userId) });
    
    if (!user) {
      return { rank: null, totalUsers: 0 };
    }
    
    // Считаем сколько пользователей имеют больше XP
    const rank = await users.countDocuments({
      paymentStatus: { $in: ['paid', 'demo'] },
      xp: { $gt: user.xp }
    }) + 1;
    
    const totalUsers = await users.countDocuments({
      paymentStatus: { $in: ['paid', 'demo'] },
      xp: { $gt: 0 }
    });
    
    return { rank, totalUsers, userXP: user.xp };
  } catch (error) {
    console.error('❌ getUserRank ошибка:', error);
    throw error;
  }
}

/**
 * Получить лидерборд друзей (пользователей приглашенных одним реферером)
 */
async function getFriendsLeaderboard(userId, limit = 20) {
  try {
    const db = getDB();
    const users = db.collection('users');
    
    // Получаем промокод пользователя
    const user = await users.findOne({ userId: parseInt(userId) });
    
    if (!user) {
      return [];
    }
    
    // Находим всех кто был приглашен этим промокодом
    const friends = await users.find({
      referredBy: user.promoCode,
      paymentStatus: { $in: ['paid', 'demo'] }
    })
    .sort({ xp: -1 })
    .limit(limit)
    .project({
      userId: 1,
      username: 1,
      name: 1,
      photoUrl: 1,
      xp: 1,
      currentStreak: 1,
      unlockedBadges: 1
    })
    .toArray();
    
    return friends;
  } catch (error) {
    console.error('❌ getFriendsLeaderboard ошибка:', error);
    throw error;
  }
}

// Функция для проверки и выдачи новых бейджей
async function checkAndUnlockBadges(userId) {
  try {
    const db = getDB();
    const users = db.collection('users');
    const user = await users.findOne({ userId });
    
    if (!user) return;
    
    const unlockedBadges = user.unlockedBadges || [];
    let newBadges = [...unlockedBadges];
    
    // Проверка: Друг народа (10+ рефералов)
    if ((user.invitedCount || 0) >= 10 && !newBadges.includes('social_butterfly')) {
      newBadges.push('social_butterfly');
    }
    
    // Проверка: Лидер друзей (1 место среди друзей)
    const friendsLeaderboard = await getFriendsLeaderboard(userId, 20);
    if (friendsLeaderboard && friendsLeaderboard.length > 0 && friendsLeaderboard[0].userId === userId && !newBadges.includes('friends_leader')) {
      newBadges.push('friends_leader');
    }
    
    // Проверка: Легенда (10000+ XP)
    if (user.xp >= 10000 && !newBadges.includes('legend')) {
      newBadges.push('legend');
    }
    
    // Если есть новые бейджи - обновить
    if (newBadges.length > unlockedBadges.length) {
      await users.updateOne(
        { userId },
        { $set: { unlockedBadges: newBadges } }
      );
      console.log(`✨ Пользователь ${userId} получил новые бейджи:`, newBadges.filter(b => !unlockedBadges.includes(b)));
    }
    
    return newBadges;
  } catch (error) {
    console.error('Ошибка проверки бейджей:', error);
    return [];
  }
}

// =====================================================
// ЭКСПОРТЫ (ТОЛЬКО ОДИН РАЗ!)
// =====================================================

export {
  getOrCreateUser,
  getUserById,
  getUserByPromoCode,
  incrementReferralCount,
  updateUserProgress,
  getUserFullData,
  updateUserOnboarding,
  checkPromoCode,
  markPromoCodeAsUsed,
  updatePaymentStatus,
  approvePayment,
  rejectPayment,
  getUserAccess,
  getPendingPayments,
  checkDemoExpiration,
  addUserXP,
  getGlobalLeaderboard,
  getUserRank,
  getFriendsLeaderboard
};