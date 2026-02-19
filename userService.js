// userService.js
import { getDB } from './db.js';

/**
 * ✅ ТАБЛИЦА НАЧИСЛЕНИЯ XP ЗА ЗАДАЧИ
 */
const XP_VALUES = {
  // Намазы
  fajr: 50,
  duha: 30,
  dhuhr: 50,
  asr: 50,
  maghrib: 50,
  isha: 50,
  taraweeh: 100,
  tahajjud: 100,
  witr: 50,
  eidPrayer: 200,
  
  // Духовные практики
  fasting: 200,
  quranRead: 100,
  morningDhikr: 30,
  eveningDhikr: 30,
  salawat: 20,
  hadith: 50,
  charity: 100,
  names99: 50,
  lessons: 50,
  book: 50,
  // 99 имён Аллаха (обрабатывается отдельно)
  singleName: 100 // За каждое заученное имя
};

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
      subscriptionExpiresAt: null, // ✅ НОВОЕ: Дата окончания подписки
      subscriptionNotified3Days: false, // ✅ НОВОЕ: Флаг уведомления за 3 дня
      subscriptionNotified1Day: false,  // ✅ НОВОЕ: Флаг уведомления за 1 день
      
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
    
    // ✅ Текущая дата в Almaty timezone
    const almatyOffset = 5 * 60;
    const now = new Date();
    const almatyTime = new Date(now.getTime() + (almatyOffset + now.getTimezoneOffset()) * 60000);
    const todayDateStr = almatyTime.toISOString().split('T')[0];
    
    // ✅ Получаем СТАРЫЕ данные из БД
    const oldUser = await usersCollection.findOne({ userId: parseInt(userId) });
    if (!oldUser) {
      console.error('❌ Пользователь не найден:', userId);
      return false;
    }
    
    // ✅ НАЧИСЛЯЕМ XP - сравниваем старое и новое
    let xpToAdd = 0;
    
    // Проверяем Рамадан прогресс
    if (progressData.progress) {
      const oldProgress = oldUser.progress || {};
      for (const day in progressData.progress) {
        const dayNum = parseInt(day);
        const newDayData = progressData.progress[day];
        const oldDayData = oldProgress[day] || {};
        
        // ✅ Вычисляем дату этого дня Рамадана
        const ramadanStartDate = new Date('2026-02-19T00:00:00');
        const dayDate = new Date(ramadanStartDate);
        dayDate.setUTCDate(ramadanStartDate.getUTCDate() + (dayNum - 1));
        const dayDateStr = dayDate.toISOString().split('T')[0];
        
        // ✅ XP только если это СЕГОДНЯ
        const isToday = dayDateStr === todayDateStr;
        
        if (isToday) {
          const earnedTasks = oldUser.earnedTasks || {};
          const todayEarned = [...(earnedTasks[todayDateStr] || [])];

          for (const taskKey in newDayData) {
            const newValue = newDayData[taskKey];

            // ✅ XP только если задача ещё не зачтена сегодня
            if (newValue === true && !todayEarned.includes(taskKey)) {
              const baseXP = XP_VALUES[taskKey] || 10;
              const currentStreak = oldUser.currentStreak || 0;
              const streakMultiplier = Math.min(1 + (currentStreak * 0.1), 3.0);
              const finalXP = Math.floor(baseXP * streakMultiplier);
              xpToAdd += finalXP;
              todayEarned.push(taskKey);
              console.log(`✅ +${finalXP} XP за ${taskKey} (день ${dayNum}, streak x${streakMultiplier.toFixed(1)})`);
            }
            // ❌ Снятие галочки — XP НЕ вычитаем (уже зачтено)
          }

          if (!updateFields.earnedTasks) updateFields.earnedTasks = { ...(oldUser.earnedTasks || {}) };
          updateFields.earnedTasks[todayDateStr] = todayEarned;
        }
      }
    }
    
    // Проверяем Preparation прогресс
    if (progressData.preparationProgress) {
      
      const oldPrep = oldUser.preparationProgress || {};
      for (const day in progressData.preparationProgress) {
        const dayNum = parseInt(day);
        const newDayData = progressData.preparationProgress[day];
        const oldDayData = oldPrep[day] || {};
        
        // ✅ ИСПРАВЛЕНО: Вычисляем дату дня подготовки
        // День 1 = 9 февраля 2026, День 2 = 10 февраля, и т.д.
        const prepStartDate = new Date('2026-02-09T00:00:00');
        const currentDayDate = new Date(prepStartDate);
        currentDayDate.setUTCDate(prepStartDate.getUTCDate() + (dayNum - 1));
        const dayDateStr = currentDayDate.toISOString().split('T')[0];
        
        const isToday = dayDateStr === todayDateStr;
        
        if (isToday) {
          const earnedTasks = oldUser.earnedTasks || {};
          const todayEarned = [...(earnedTasks[todayDateStr] || [])];

          for (const taskKey in newDayData) {
            const newValue = newDayData[taskKey];

            if (newValue === true && !todayEarned.includes(taskKey)) {
              const baseXP = XP_VALUES[taskKey] || 10;
              const currentStreak = oldUser.currentStreak || 0;
              const streakMultiplier = Math.min(1 + (currentStreak * 0.1), 3.0);
              const finalXP = Math.floor(baseXP * streakMultiplier);
              xpToAdd += finalXP;
              todayEarned.push(taskKey);
              console.log(`✅ +${finalXP} XP за ${taskKey} (подготовка день ${dayNum})`);
            }
            // ❌ Снятие галочки — XP НЕ вычитаем
          }

          if (!updateFields.earnedTasks) updateFields.earnedTasks = { ...(oldUser.earnedTasks || {}) };
          updateFields.earnedTasks[todayDateStr] = todayEarned;
        }
      }
    }
    
    // Проверяем Basic прогресс (по датам)
    if (progressData.basicProgress) {
      const oldBasic = oldUser.basicProgress || {};
      for (const dateKey in progressData.basicProgress) {
        const newDayData = progressData.basicProgress[dateKey];
        const oldDayData = oldBasic[dateKey] || {};
        
        const isToday = dateKey === todayDateStr;
        
        if (isToday) {
          const earnedTasks = oldUser.earnedTasks || {};
          const todayEarned = [...(earnedTasks[todayDateStr] || [])];

          for (const taskKey in newDayData) {
            const newValue = newDayData[taskKey];

            if (newValue === true && !todayEarned.includes(taskKey)) {
              const baseXP = XP_VALUES[taskKey] || 10;
              const currentStreak = oldUser.currentStreak || 0;
              const streakMultiplier = Math.min(1 + (currentStreak * 0.1), 3.0);
              const finalXP = Math.floor(baseXP * streakMultiplier);
              xpToAdd += finalXP;
              todayEarned.push(taskKey);
              console.log(`✅ +${finalXP} XP за ${taskKey} (базовый ${dateKey})`);
            }
            // ❌ Снятие галочки — XP НЕ вычитаем
          }

          if (!updateFields.earnedTasks) updateFields.earnedTasks = { ...(oldUser.earnedTasks || {}) };
          updateFields.earnedTasks[todayDateStr] = todayEarned;
        }
      }
    }

    // ✅ Проверяем заучивание имён Аллаха (99 имён)
    if (progressData.memorizedNames) {
      const oldMemorized = oldUser.memorizedNames || [];
      const newMemorized = progressData.memorizedNames || [];
      
      // Находим НОВЫЕ имена (которых не было в старом массиве)
      const newlyMemorized = newMemorized.filter(id => !oldMemorized.includes(id));
      
      if (newlyMemorized.length > 0) {
        const baseNameXP = 100; // 100 XP за каждое имя
        const nameXPToAdd = newlyMemorized.length * baseNameXP;
        
        // ✅ XP за имена НЕ умножаются на streak - это отдельная активность
        xpToAdd += nameXPToAdd;
        
        console.log(`📿 +${nameXPToAdd} XP за заучивание ${newlyMemorized.length} имён Аллаха: [${newlyMemorized.join(', ')}]`);
      }
      
      // Проверка: если пользователь убрал имена (не должно происходить, но на всякий случай)
      const removedNames = oldMemorized.filter(id => !newMemorized.includes(id));
      if (removedNames.length > 0) {
        console.log(`⚠️ Внимание: убраны имена ${removedNames.join(', ')} - XP не вычитаем`);
        // НЕ вычитаем XP за убранные имена - защита от случайных потерь
      }
    }
    
    // ✅ ОБНОВЛЯЕМ STREAK
    const lastActiveDate = oldUser.lastActiveDate || '';
    const yesterday = new Date(almatyTime);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    
    let newStreak = oldUser.currentStreak || 0;
    
    // Проверяем была ли активность сегодня
    const hasActivityToday = xpToAdd > 0;
    
    if (hasActivityToday) {
      if (lastActiveDate === yesterdayStr) {
        // Продолжаем серию
        newStreak += 1;
      } else if (lastActiveDate !== todayDateStr) {
        // Начинаем новую серию
        newStreak = 1;
      }
      // Если lastActiveDate === todayDateStr - уже активен сегодня, не меняем
    }
    
    const longestStreak = Math.max(oldUser.longestStreak || 0, newStreak);
    
    // ✅ Создаем объект только с теми полями, которые пришли
    const updateFields = {
      updatedAt: new Date()
    };
    
    // ✅ ЗАЩИТА: Не сохраняем пустые объекты/массивы для критических полей
    const shouldUpdate = (value) => {
      if (value === undefined || value === null) return false;
      if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return false;
      return true;
    };
    
    // ✅ Добавляем только те поля, которые есть в progressData И НЕ пустые
    if (progressData.name !== undefined) updateFields.name = progressData.name;
    if (progressData.username !== undefined) updateFields.username = progressData.username;
    if (progressData.photoUrl !== undefined) updateFields.photoUrl = progressData.photoUrl;
    if (progressData.registrationDate !== undefined) updateFields.registrationDate = progressData.registrationDate;
    
    // ✅ КРИТИЧЕСКИЕ ПОЛЯ
    if (shouldUpdate(progressData.progress)) updateFields.progress = progressData.progress;
    if (shouldUpdate(progressData.preparationProgress)) updateFields.preparationProgress = progressData.preparationProgress;
    if (shouldUpdate(progressData.basicProgress)) updateFields.basicProgress = progressData.basicProgress;
    
    // Массивы и другие поля
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
    
    // ✅ XP - НЕ берём с фронта, считаем сами!
    updateFields.xp = (oldUser.xp || 0) + xpToAdd;
    
    if (progressData.hasRedeemedReferral !== undefined) updateFields.hasRedeemedReferral = progressData.hasRedeemedReferral;
    if (progressData.unlockedBadges !== undefined) updateFields.unlockedBadges = progressData.unlockedBadges;
    
    // ✅ STREAK данные
    if (hasActivityToday) {
      updateFields.currentStreak = newStreak;
      updateFields.longestStreak = longestStreak;
      updateFields.lastActiveDate = todayDateStr;
    }
    
    const result = await usersCollection.updateOne(
      { userId: parseInt(userId) },
      { $set: updateFields }
    );
    
    if (result.modifiedCount > 0 || xpToAdd > 0) {
      console.log(`✅ Прогресс обновлен для userId: ${userId}, начислено XP: ${xpToAdd}`);
      
      // ✅ Возвращаем данные о начисленном XP
      const currentStreak = hasActivityToday ? newStreak : (oldUser.currentStreak || 0);
      const streakMultiplier = Math.min(1 + (currentStreak * 0.1), 3.0);
      
      return {
        success: true,
        xpAdded: xpToAdd,
        streakMultiplier: xpToAdd > 0 ? streakMultiplier : 1.0,
        currentStreak: currentStreak
      };
    }

    console.log('⚠️ Прогресс не изменился для userId:', userId);
    return {
      success: true,
      xpAdded: 0,
      streakMultiplier: 1.0,
      currentStreak: oldUser.currentStreak || 0
    };
    
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
      registrationDate: user.createdAt || user.registrationDate,
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
      lastActiveDate: user.lastActiveDate || '',  // ✅ ДОБАВЬТЕ
      subscriptionExpiresAt: user.subscriptionExpiresAt || null, // ✅ ДОБАВЛЕНО
      daysLeft: user.subscriptionExpiresAt ? Math.ceil((new Date(user.subscriptionExpiresAt) - new Date()) / (1000 * 60 * 60 * 24)) : null // ✅ ДОБАВЛЕНО
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

  const normalizedCode = promoCode.toUpperCase();

  // Ищем владельца промокода
  const owner = await users.findOne({ promoCode: normalizedCode });

  if (!owner) {
    return { valid: false, reason: 'not_found' };
  }

  // Нельзя использовать свой промокод
  if (owner.userId === userId) {
    return { valid: false, reason: 'own_code' };
  }

  // Владелец промокода должен быть платящим пользователем
  if (owner.paymentStatus !== 'paid') {
    return { valid: false, reason: 'owner_not_paid' };
  }

  // ✅ Больше НЕ проверяем used_promocodes — промокод может использовать много людей
  return { valid: true, owner };
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
  
  // ✅ ПОДПИСКА НА 90 ДНЕЙ
  const subscriptionExpiresAt = new Date();
  subscriptionExpiresAt.setDate(subscriptionExpiresAt.getDate() + 90);
  
  const updateData = {
    paymentStatus: 'paid',
    accessType: 'full',
    paymentDate: new Date(),
    subscriptionExpiresAt: subscriptionExpiresAt, // ✅ НОВОЕ
    subscriptionNotified3Days: false, // ✅ Сбрасываем флаги уведомлений
    subscriptionNotified1Day: false,  // ✅ Сбрасываем флаги уведомлений
    onboardingCompleted: true,
    updatedAt: new Date()
  };
  
  await users.updateOne({ userId }, { $set: updateData });
  
  // ✅ НАЧИСЛЯЕМ XP РЕФЕРЕРУ ЗА ОПЛАТУ
  if (user.referredBy) {
    const referrer = await users.findOne({ promoCode: user.referredBy });
    if (referrer) {
      await addReferralXP(referrer.userId, 'payment', userId, user.name);
    }
  }
  
  console.log(`✅ Оплата подтверждена для пользователя ${userId}`);
  console.log(`📅 Подписка активна до: ${subscriptionExpiresAt.toLocaleDateString('ru-RU')}`);
  
  return true;
}

async function rejectPayment(userId) {
  const db = getDB();
  const users = db.collection('users');
  
  // ✅ Получаем текущие данные пользователя
  const user = await users.findOne({ userId });
  
  let demoExpiresAt = null;
  let accessType = null;
  let demoStatus = 'none'; // none, active, given_new
  
  // ✅ ПРОВЕРКА 1: Если демо УЖЕ активен и НЕ истёк - НЕ ТРОГАЕМ!
  if (user.accessType === 'demo' && user.demoExpiresAt && new Date() < new Date(user.demoExpiresAt)) {
    demoExpiresAt = user.demoExpiresAt; // Оставляем старую дату
    accessType = 'demo';
    demoStatus = 'active';
    console.log(`ℹ️ Демо-режим ещё активен до ${demoExpiresAt}. Не перезапускаем.`);
  } 
  // ✅ ПРОВЕРКА 2: Если демо НЕ активен, но уже давали раньше - НЕ ДАЁМ повторно
  else if (user.demoGivenOnRejection || user.demoActivatedManually) {
    demoExpiresAt = null;
    accessType = null;
    demoStatus = 'none';
    console.log(`⚠️ Пользователь ${userId} уже получал демо. Не даётся повторно.`);
  } 
  // ✅ ПРОВЕРКА 3: Первый раз получает демо при отклонении
  else {
    demoExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    accessType = 'demo';
    demoStatus = 'given_new';
    console.log(`🎁 Первое отклонение. Даём демо-доступ до ${demoExpiresAt}`);
  }
  
  const updateData = {
    paymentStatus: 'unpaid',
    accessType: accessType,
    demoExpiresAt: demoExpiresAt,
    demoGivenOnRejection: demoStatus === 'given_new' ? true : user.demoGivenOnRejection,
    updatedAt: new Date()
    // ✅ usedPromoCode и referredBy НЕ ТРОГАЕМ!
  };
  
  await users.updateOne({ userId }, { $set: updateData });
  
  console.log(`❌ Оплата отклонена для пользователя ${userId}. Статус демо: ${demoStatus}`);
  
  return { demoStatus, demoExpiresAt };
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
  
  // ✅ ПРОВЕРКА ПОДПИСКИ (90 дней)
  if (user.paymentStatus === 'paid') {
    // Если есть subscriptionExpiresAt - проверяем истекла ли подписка
    if (user.subscriptionExpiresAt) {
      const now = new Date();
      const expiresAt = new Date(user.subscriptionExpiresAt);
      
      if (now < expiresAt) {
        // Подписка активна
        const daysLeft = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
        return { 
          hasAccess: true, 
          paymentStatus: 'paid', 
          subscriptionExpires: user.subscriptionExpiresAt,
          daysLeft: daysLeft
        };
      } else {
        // Подписка истекла
        return { 
          hasAccess: false, 
          paymentStatus: 'subscription_expired', 
          reason: 'Подписка истекла',
          subscriptionExpired: true
        };
      }
    }
    
    // ✅ Старые пользователи без subscriptionExpiresAt - даём доступ (обратная совместимость)
    return { 
      hasAccess: true, 
      paymentStatus: 'paid',
      reason: 'legacy_user'
    };
  }
  
  // Платёж на проверке
  if (user.paymentStatus === 'pending') {
    // ✅ Если был в демо и отправил чек - СОХРАНЯЕМ demo доступ до одобрения
    if (user.accessType === 'demo' && user.demoExpiresAt && new Date() < new Date(user.demoExpiresAt)) {
      return { 
        hasAccess: true, 
        paymentStatus: 'demo', 
        demoExpires: user.demoExpiresAt,
        paymentPending: true // ← Флаг что чек на проверке
      };
    }
    
    // Если демо истекло или не было - блокируем
    return { 
      hasAccess: false, 
      paymentStatus: 'pending',
      reason: 'payment_pending'
    };
  }
  
  // Подписка истекла (отдельный статус)
  if (user.paymentStatus === 'subscription_expired') {
    return { 
      hasAccess: false, 
      paymentStatus: 'subscription_expired',
      reason: 'subscription_expired'
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

// Получить список всех стран пользователей
async function getCountries() {
  try {
    const db = getDB();
    const users = db.collection('users');
    
    const countries = await users.distinct('location.country', {
      'location.country': { $ne: null },
      'location.country': { $ne: '' },
      onboardingCompleted: true
    });
    
    // ✅ Нормализация к английским названиям
    const countryNormalization = {
      'Қазақстан': 'Kazakhstan',
      'Ресей': 'Russia',
      'Россия': 'Russia',
      'Түркия': 'Turkey',
      'Турция': 'Turkey',
      'Өзбекстан': 'Uzbekistan',
      'Узбекистан': 'Uzbekistan'
    };
    
    const normalized = countries
      .map(country => countryNormalization[country] || country)
      .filter(c => c && c !== 'Unknown');
    
    const unique = [...new Set(normalized)];
    
    return unique.sort();
  } catch (error) {
    console.error('❌ Ошибка получения стран:', error);
    return [];
  }
}

// Получить список городов в стране
async function getCities(country) {
  try {
    const db = getDB();
    const users = db.collection('users');
    
    const cities = await users.distinct('location.city', {
      'location.country': country,
      'location.city': { $ne: null },
      'location.city': { $ne: '' },
      onboardingCompleted: true
    });
    
    return cities.filter(c => c && c !== 'Unknown').sort();
  } catch (error) {
    console.error('❌ Ошибка получения городов:', error);
    return [];
  }
}

// Лидерборд с фильтрами по стране/городу
async function getFilteredLeaderboard(options = {}) {
  try {
    const { limit = 50, offset = 0, country = null, city = null } = options;
    const db = getDB();
    const users = db.collection('users');
    
    // Базовый фильтр
    const filter = {
      onboardingCompleted: true,
      xp: { $gt: 0 }
    };
    
    // Фильтр по стране
    if (country) {
      filter['location.country'] = country;
    }
    
    // Фильтр по городу
    if (city) {
      filter['location.city'] = city;
    }
    
    // Получаем лидерборд
    const leaderboard = await users
      .find(filter)
      .sort({ xp: -1 })
      .skip(offset)
      .limit(limit)
      .project({
        userId: 1,
        username: 1,
        name: 1,
        photoUrl: 1,
        xp: 1,
        currentStreak: 1,
        unlockedBadges: 1,
        invitedCount: 1,
        'location.city': 1,
        'location.country': 1
      })
      .toArray();
    
    // Считаем общее количество
    const total = await users.countDocuments(filter);
    
    return {
      data: leaderboard,
      total,
      hasMore: offset + limit < total
    };
  } catch (error) {
    console.error('❌ Ошибка получения лидерборда с фильтрами:', error);
    throw error;
  }
}

/**
 * Начисление XP за реферала
 * @param {number} userId - ID реферера
 * @param {string} type - 'registration' или 'payment'
 * @param {number} referredUserId - ID реферала
 * @param {string} referredUserName - Имя реферала
 */
async function addReferralXP(userId, type = 'registration', referredUserId = null, referredUserName = null) {
  try {
    const db = getDB();
    const users = db.collection('users');
    
    // ✅ Текущая дата в Almaty timezone
    const almatyOffset = 5 * 60;
    const now = new Date();
    const almatyTime = new Date(now.getTime() + (almatyOffset + now.getTimezoneOffset()) * 60000);
    const todayDateStr = almatyTime.toISOString().split('T')[0];
    
    // ✅ Проверка: до 20 марта включительно
    const eidDate = new Date('2026-03-20T23:59:59+05:00');
    if (almatyTime > eidDate) {
      console.log('❌ Реферальные бонусы закончились после 20 марта');
      return { success: false, reason: 'period_ended' };
    }
    
    const user = await users.findOne({ userId: parseInt(userId) });
    if (!user) return { success: false, reason: 'user_not_found' };
    
    let finalXP = 0;
    let multiplier = 1.0;
    let todayCount = 0;
    
    if (type === 'payment') {
      // ✅ За ОПЛАТУ реферала - всегда 400 XP (БЕЗ множителей!)
      finalXP = 400;
      console.log(`💰 Реферал ${referredUserId} оплатил подписку → +400 XP для реферера ${userId}`);
      
    } else {
      // ✅ За РЕГИСТРАЦИЮ (приглашение) - с множителями
      const dailyReferrals = user.dailyReferrals || {};
      todayCount = (dailyReferrals[todayDateStr] || 0) + 1;
      
      // Определяем множитель по количеству рефералов за сегодня
      if (todayCount >= 50) {
        multiplier = 2.0;
      } else if (todayCount >= 20) {
        multiplier = 1.6;
      } else if (todayCount >= 5) {
        multiplier = 1.3;
      }
      
      const baseRegistrationXP = 100;
      finalXP = Math.floor(baseRegistrationXP * multiplier);
      
      console.log(`👥 Новый реферал #${todayCount} сегодня → +${finalXP} XP (x${multiplier.toFixed(1)}) для реферера ${userId}`);
    }
    
    // ✅ Обновляем пользователя
    const updateData = {
      xp: (user.xp || 0) + finalXP,
      updatedAt: new Date()
    };
    
    // Только для регистрации увеличиваем счётчики
    if (type === 'registration') {
      updateData[`dailyReferrals.${todayDateStr}`] = todayCount;
      updateData.invitedCount = (user.invitedCount || 0) + 1;
    }
    
    await users.updateOne(
      { userId: parseInt(userId) },
      { $set: updateData }
    );
    
    console.log(`✅ Реферер ${userId}: теперь ${updateData.xp} XP`);
    
    return { 
      success: true, 
      xp: finalXP, 
      multiplier: type === 'payment' ? 1.0 : multiplier, 
      todayCount: type === 'registration' ? todayCount : 0,
      referredUserName,
      type
    };
  } catch (error) {
    console.error('❌ Error adding referral XP:', error);
    return { success: false, reason: 'error' };
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
  updatePaymentStatus,
  approvePayment,
  rejectPayment,
  getUserAccess,
  getPendingPayments,
  checkDemoExpiration,
  addUserXP,
  getGlobalLeaderboard,
  getUserRank,
  getFriendsLeaderboard,
  getCountries,
  getCities,
  getFilteredLeaderboard,
  addReferralXP
};