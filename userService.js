// userService.js
import { getDB } from './db.js';

/**
 * ✅ ТАБЛИЦА НАЧИСЛЕНИЯ XP ЗА ЗАДАЧИ
 */
const XP_VALUES = {
  fajr: 50, duha: 30, dhuhr: 50, asr: 50, maghrib: 50, isha: 50,
  taraweeh: 100, tahajjud: 100, witr: 50, eidPrayer: 200,
  fasting: 200, quranRead: 100, morningDhikr: 30, eveningDhikr: 30,
  salawat: 20, hadith: 50, charity: 100, names99: 50, lessons: 50, book: 50,
  singleName: 100
};

// ─── ДОПУСТИМЫЕ XP ЗА КАТЕГОРИИ ЦЕЛЕЙ (v2) ───
const GOAL_CATEGORY_MAX_XP = {
  prayer:    150,
  quran:     200,
  dhikr:     100,
  fasting:   200,
  charity:   150,
  selfdev:   100,
};

/**
 * #B3 FIX: Получить «сегодня» в таймзоне пользователя.
 * Если timezone не задан — берём 'Asia/Almaty' (UTC+5, Казахстан).
 * Если timezone невалиден — тоже фолбэк на 'Asia/Almaty'.
 */
function getTodayStr(timezone) {
  const tz = timezone || 'Asia/Almaty';
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: tz });
  } catch {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Almaty' });
  }
}

async function generateUniquePromoCode(usersCollection) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const exists = await usersCollection.findOne({ promoCode: code });
    if (!exists) return code;
  }
  return Date.now().toString(36).toUpperCase().slice(-6);
}

/**
 * Создать или получить пользователя
 */
async function getOrCreateUser(userId, username = null) {
  const db = getDB();
  const users = db.collection('users');
  let user = await users.findOne({ userId });

  if (!user) {
    const promoCode = await generateUniquePromoCode(users);
    const newUser = {
      userId,
      username: username ? `@${username}` : null,
      promoCode,
      invitedCount: 0,
      name: null,
      phoneNumber: null,
      location: { city: null, country: null, latitude: null, longitude: null, timezone: null },
      prayerTimes: { fajr: null, sunrise: null, dhuhr: null, asr: null, maghrib: null, isha: null, lastUpdated: null },
      notificationSettings: { ramadanReminders: true, reminderMinutesBefore: 30 },
      referredBy: null,
      usedPromoCode: null,
      paymentStatus: 'unpaid',
      paidAmount: null,
      hasDiscount: false,
      receiptPhotoId: null,
      receiptMessageId: null,
      paymentDate: null,
      subscriptionExpiresAt: null,
      subscriptionNotified3Days: false,
      subscriptionNotified1Day: false,
      accessType: null,
      demoExpiresAt: null,
      progress: {},
      preparationProgress: {},
      basicProgress: {},
      memorizedNames: [],
      completedJuzs: [],
      earnedJuzXpIds: [],
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
      // ✅ ПОЛЯ Мақсаттар v2
      dailyGoalRecords: {},      // { '2026-03-01': [ DailyGoalRecord, ... ] }
      goalCustomItems: {},        // { prayer: [ CustomGoalItem, ... ] }
      // FIX #B1: goalStreaks хранит объекты { current, longest, lastCompletedDate }
      goalStreaks: {},             // { prayer: { current:3, longest:5, lastCompletedDate:'2026-03-01' }, ... }
      earnedGoalXp: {},           // { '2026-03-01': { prayer: true, quran: true } }
      tasbeehRecords: {},
      earnedTasbeehXp: {},
      tasbeehTotals: {},
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

async function getUserById(userId) {
  try {
    const db = getDB();
    return await db.collection('users').findOne({ userId: parseInt(userId) });
  } catch (error) {
    console.error('❌ Ошибка в getUserById:', error);
    throw error;
  }
}

async function getUserByPromoCode(promoCode) {
  try {
    const db = getDB();
    return await db.collection('users').findOne({ promoCode: promoCode.toUpperCase() });
  } catch (error) {
    console.error('❌ Ошибка в getUserByPromoCode:', error);
    throw error;
  }
}

async function incrementReferralCount(promoCode) {
  try {
    const db = getDB();
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ promoCode: promoCode.toUpperCase() });
    const result = await usersCollection.updateOne(
      { promoCode: promoCode.toUpperCase() },
      { $inc: { invitedCount: 1 }, $set: { updatedAt: new Date() } }
    );
    if (result.modifiedCount > 0 && user) {
      await checkAndUnlockBadges(user.userId);
      return true;
    }
    return false;
  } catch (error) {
    console.error('❌ incrementReferralCount:', error);
    throw error;
  }
}

/**
 * Обновить полный прогресс пользователя (sync endpoint)
 */
async function updateUserProgress(userId, progressData) {
  try {
    const db = getDB();
    const usersCollection = db.collection('users');

    const oldUser = await usersCollection.findOne({ userId: parseInt(userId) });
    if (!oldUser) { console.error('❌ Пользователь не найден:', userId); return false; }

    // FIX #B3: используем безопасную функцию getTodayStr
    const userTimezone = oldUser.location?.timezone || 'Asia/Almaty';
    const todayDateStr = getTodayStr(userTimezone);
    const now = new Date();

    let xpToAdd = 0;
    const earnedTasksFromDB = oldUser.earnedTasks || {};
    const todayEarned = [...(earnedTasksFromDB[todayDateStr] || [])];

    // ─── XP за Ramadan прогресс ───
    if (progressData.progress) {
      const oldProgress = oldUser.progress || {};
      for (const day in progressData.progress) {
        const dayNum = parseInt(day);
        const newDayData = progressData.progress[day];
        const oldDayData = oldProgress[day] || {};
        const ramadanDay = new Date(2026, 1, 19 + (dayNum - 1));
        const dayDateStr = ramadanDay.toLocaleDateString('en-CA', { timeZone: userTimezone });
        if (dayDateStr === todayDateStr) {
          for (const taskKey in newDayData) {
            if (newDayData[taskKey] === true && !oldDayData[taskKey] && !todayEarned.includes(taskKey)) {
              const baseXP = XP_VALUES[taskKey] || 10;
              const streakMultiplier = Math.min(1 + ((oldUser.currentStreak || 0) * 0.1), 3.0);
              xpToAdd += Math.floor(baseXP * streakMultiplier);
              todayEarned.push(taskKey);
              console.log(`✅ +${Math.floor(baseXP * streakMultiplier)} XP за ${taskKey}`);
            }
          }
        }
      }
    }

    // ─── XP за Preparation прогресс ───
    if (progressData.preparationProgress) {
      const oldPrep = oldUser.preparationProgress || {};
      for (const day in progressData.preparationProgress) {
        const dayNum = parseInt(day);
        const newDayData = progressData.preparationProgress[day];
        const oldDayData = oldPrep[day] || {};
        const prepDay = new Date(2026, 1, 9 + (dayNum - 1));
        const dayDateStr = prepDay.toLocaleDateString('en-CA', { timeZone: userTimezone });
        if (dayDateStr === todayDateStr) {
          for (const taskKey in newDayData) {
            if (newDayData[taskKey] === true && !oldDayData[taskKey] && !todayEarned.includes(taskKey)) {
              const baseXP = XP_VALUES[taskKey] || 10;
              const streakMultiplier = Math.min(1 + ((oldUser.currentStreak || 0) * 0.1), 3.0);
              xpToAdd += Math.floor(baseXP * streakMultiplier);
              todayEarned.push(taskKey);
            }
          }
        }
      }
    }

    // ─── XP за Basic прогресс ───
    if (progressData.basicProgress) {
      const oldBasic = oldUser.basicProgress || {};
      for (const dateKey in progressData.basicProgress) {
        if (dateKey === todayDateStr) {
          const newDayData = progressData.basicProgress[dateKey];
          const oldDayData = oldBasic[dateKey] || {};
          for (const taskKey in newDayData) {
            if (newDayData[taskKey] === true && !oldDayData[taskKey] && !todayEarned.includes(taskKey)) {
              const baseXP = XP_VALUES[taskKey] || 10;
              const streakMultiplier = Math.min(1 + ((oldUser.currentStreak || 0) * 0.1), 3.0);
              xpToAdd += Math.floor(baseXP * streakMultiplier);
              todayEarned.push(taskKey);
            }
          }
        }
      }
    }

    // ─── ✅ XP за dailyGoalRecords (v2) — ЕДИНСТВЕННОЕ место начисления ───
    // FIX #B2: убрана дублирующая логика earnedGoalXp ниже — всё в одном месте
    const mergedEarnedGoalXp = { ...(oldUser.earnedGoalXp || {}) };
    if (progressData.dailyGoalRecords) {
      const todayEarnedGoals = { ...(mergedEarnedGoalXp[todayDateStr] || {}) };

      const incomingToday = progressData.dailyGoalRecords[todayDateStr];
      if (Array.isArray(incomingToday)) {
        for (const record of incomingToday) {
          const { categoryId, completed, xpEarned } = record;

          // Защита 1: категория уже зачтена сегодня
          if (todayEarnedGoals[categoryId]) {
            console.log(`🛡️ Блок: повторное начисление XP за ${categoryId} — уже зачтено сегодня`);
            continue;
          }
          // Защита 2: только completed
          if (!completed) continue;
          // Защита 3: maxXP по категории
          const maxXp = GOAL_CATEGORY_MAX_XP[categoryId] || 100;
          const safeXp = Math.min(Math.max(parseInt(xpEarned) || 0, 0), maxXp);
          if (safeXp <= 0) continue;

          const streakMultiplier = Math.min(1 + ((oldUser.currentStreak || 0) * 0.1), 3.0);
          const finalXp = Math.floor(safeXp * streakMultiplier);
          xpToAdd += finalXp;
          todayEarnedGoals[categoryId] = true;
          console.log(`🎯 +${finalXp} XP за цель категории ${categoryId} (x${streakMultiplier.toFixed(2)})`);
        }
      }
      // Записываем обновлённый earnedGoalXp один раз
      mergedEarnedGoalXp[todayDateStr] = todayEarnedGoals;
    }

    // ─── ОБНОВЛЕНИЕ СТРИКА ───
    const lastActiveDate = oldUser.lastActiveDate || '';
    const yesterdayStr = new Date(now.getTime() - 86400000)
      .toLocaleDateString('en-CA', { timeZone: userTimezone });
    let newStreak = oldUser.currentStreak || 0;
    const hasActivityToday = xpToAdd > 0;
    if (hasActivityToday) {
      if (lastActiveDate === yesterdayStr) newStreak += 1;
      else if (lastActiveDate !== todayDateStr) newStreak = 1;
    }
    const longestStreak = Math.max(oldUser.longestStreak || 0, newStreak);

    // ─── ОБЪЕКТ ОБНОВЛЕНИЯ ───
    const updateFields = { updatedAt: new Date() };
    const shouldUpdate = (value) => {
      if (value === undefined || value === null) return false;
      if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return false;
      return true;
    };

    // earnedTasks (старая система)
    const newEarnedTasks = { ...earnedTasksFromDB };
    newEarnedTasks[todayDateStr] = todayEarned;
    updateFields.earnedTasks = newEarnedTasks;

    // FIX #B2: earnedGoalXp записывается ровно один раз — из mergedEarnedGoalXp выше
    if (progressData.dailyGoalRecords !== undefined) {
      updateFields.earnedGoalXp = mergedEarnedGoalXp;
    }

    if (progressData.name !== undefined) updateFields.name = progressData.name;
    if (progressData.username !== undefined) updateFields.username = progressData.username;
    if (progressData.photoUrl !== undefined) updateFields.photoUrl = progressData.photoUrl;
    if (progressData.registrationDate !== undefined) updateFields.registrationDate = progressData.registrationDate;
    if (shouldUpdate(progressData.progress)) updateFields.progress = progressData.progress;
    if (shouldUpdate(progressData.preparationProgress)) updateFields.preparationProgress = progressData.preparationProgress;
    if (shouldUpdate(progressData.basicProgress)) updateFields.basicProgress = progressData.basicProgress;

    // memorizedNames — только растёт
    if (progressData.memorizedNames !== undefined) {
      const oldMemorized = oldUser.memorizedNames || [];
      const incoming = progressData.memorizedNames || [];
      const merged = [...new Set([...oldMemorized, ...incoming])];
      updateFields.memorizedNames = merged;
      const newlyMemorized = merged.filter(id => !oldMemorized.includes(id));
      if (newlyMemorized.length > 0) {
        xpToAdd += newlyMemorized.length * 100;
        console.log(`📿 +${newlyMemorized.length * 100} XP за новые имена`);
      }
    }

    if (progressData.completedJuzs !== undefined) updateFields.completedJuzs = progressData.completedJuzs;

    if (progressData.earnedJuzXpIds !== undefined) {
      const oldEarned = oldUser.earnedJuzXpIds || [];
      const incoming = progressData.earnedJuzXpIds || [];
      const merged = [...new Set([...oldEarned, ...incoming])];
      updateFields.earnedJuzXpIds = merged;
      const newlyEarned = merged.filter(id => !oldEarned.includes(id));
      if (newlyEarned.length > 0) {
        xpToAdd += newlyEarned.length * 150;
        console.log(`📖 +${newlyEarned.length * 150} XP за новые пары`);
      }
    }

    if (progressData.quranKhatams !== undefined) {
      const oldKhatams = oldUser.quranKhatams || 0;
      const newKhatams = progressData.quranKhatams || 0;
      if (newKhatams > oldKhatams && oldKhatams === 0) { xpToAdd += 1000; console.log(`🕋 +1000 XP за первый хатым!`); }
      updateFields.quranKhatams = newKhatams;
    }

    if (progressData.completedTasks !== undefined) updateFields.completedTasks = progressData.completedTasks;
    if (progressData.deletedPredefinedTasks !== undefined) updateFields.deletedPredefinedTasks = progressData.deletedPredefinedTasks;
    if (progressData.customTasks !== undefined) updateFields.customTasks = progressData.customTasks;
    if (progressData.quranGoal !== undefined) updateFields.quranGoal = progressData.quranGoal;
    if (progressData.dailyQuranGoal !== undefined) updateFields.dailyQuranGoal = progressData.dailyQuranGoal;
    if (progressData.dailyCharityGoal !== undefined) updateFields.dailyCharityGoal = progressData.dailyCharityGoal;
    if (progressData.language !== undefined) updateFields.language = progressData.language;
    if (progressData.hasRedeemedReferral !== undefined) updateFields.hasRedeemedReferral = progressData.hasRedeemedReferral;
    if (progressData.unlockedBadges !== undefined) updateFields.unlockedBadges = progressData.unlockedBadges;

    // ─── НОВЫЕ ПОЛЯ v2 ───

    // dailyGoalRecords: принимаем историю, защищаем зачтённые записи
    if (progressData.dailyGoalRecords !== undefined) {
      const oldRecords = oldUser.dailyGoalRecords || {};
      const incoming = progressData.dailyGoalRecords || {};
      // earnedGoalXp уже обновлён выше в mergedEarnedGoalXp
      const earnedGoalXpNow = mergedEarnedGoalXp;

      const merged = { ...oldRecords };
      for (const dateKey in incoming) {
        const incomingArr = incoming[dateKey];
        if (!Array.isArray(incomingArr)) continue;

        if (dateKey !== todayDateStr) {
          // Прошлые дни — принимаем только если не было в БД
          if (!merged[dateKey]) merged[dateKey] = incomingArr;
        } else {
          // Сегодня: защита записей, за которые уже начислен XP
          const earnedToday = earnedGoalXpNow[todayDateStr] || {};
          const existingToday = oldRecords[todayDateStr] || [];
          const protectedRecords = incomingArr.map(rec => {
            if (earnedToday[rec.categoryId]) {
              return existingToday.find(r => r.categoryId === rec.categoryId) || rec;
            }
            return rec;
          });
          merged[todayDateStr] = protectedRecords;
        }
      }
      updateFields.dailyGoalRecords = merged;
    }

    // goalCustomItems — принимаем как есть
    if (progressData.goalCustomItems !== undefined) {
      updateFields.goalCustomItems = progressData.goalCustomItems || {};
    }

    // FIX #B1: goalStreaks — фронт присылает объекты { current, longest, lastCompletedDate }.
    // Бэкенд НЕ перезаписывает streak если current фронта < current в БД (защита от откатов).
    if (progressData.goalStreaks !== undefined) {
      const oldStreaks = oldUser.goalStreaks || {};
      const incoming = progressData.goalStreaks || {};
      const mergedStreaks = { ...oldStreaks };

      for (const catId in incoming) {
        const inc = incoming[catId];
        const old = oldStreaks[catId];

        // Поддержка обоих форматов: число (legacy) и объект (v2)
        const incCurrent  = (typeof inc === 'object' && inc !== null) ? (parseInt(inc.current)  || 0) : (parseInt(inc) || 0);
        const incLongest  = (typeof inc === 'object' && inc !== null) ? (parseInt(inc.longest)  || 0) : incCurrent;
        const incLastDate = (typeof inc === 'object' && inc !== null) ? (inc.lastCompletedDate  || '') : '';

        const oldCurrent  = (typeof old === 'object' && old !== null) ? (parseInt(old.current)  || 0) : (parseInt(old) || 0);
        const oldLongest  = (typeof old === 'object' && old !== null) ? (parseInt(old.longest)  || 0) : oldCurrent;

        // Блокируем прыжок current больше чем +1 за раз (защита от накруток)
        const safeCurrent = incCurrent <= oldCurrent + 1 ? incCurrent : oldCurrent;
        const safeLongest = Math.max(oldLongest, safeCurrent, incLongest);

        mergedStreaks[catId] = {
          current: safeCurrent,
          longest: safeLongest,
          lastCompletedDate: incLastDate || ((typeof old === 'object' && old !== null) ? old.lastCompletedDate : '') || '',
        };
      }
      updateFields.goalStreaks = mergedStreaks;
    }

    // ─── tasbeehRecords: сохранить и начислить XP за выполненные зікіры ───
    if (progressData.tasbeehRecords !== undefined) {
      const oldTasbeeh = oldUser.tasbeehRecords || {};
      const incoming   = progressData.tasbeehRecords || {};
      const earnedTasbeehXp = { ...(oldUser.earnedTasbeehXp || {}) };

      const TASBEEH_XP = {
        subhanallah: 33, alhamdulillah: 33, allahuakbar: 33,
        astaghfirullah: 100, lailaha: 100, salavat: 100,
      };

      const merged = { ...oldTasbeeh };
      for (const dateKey in incoming) {
        const dayRecord = incoming[dateKey];
        if (!dayRecord) continue;

        merged[dateKey] = dayRecord;

        if (dateKey === todayDateStr) {
          const todayEarnedDhikrs = [...(earnedTasbeehXp[todayDateStr] || [])];
          const completedIds = dayRecord.completedIds || [];

          for (const dhikrId of completedIds) {
            if (!todayEarnedDhikrs.includes(dhikrId)) {
              const dhikrXp = TASBEEH_XP[dhikrId] || 30;
              xpToAdd += dhikrXp;
              todayEarnedDhikrs.push(dhikrId);
              console.log(`📿 +${dhikrXp} XP за зікір ${dhikrId}`);
            }
          }
          earnedTasbeehXp[todayDateStr] = todayEarnedDhikrs;
        }
      }

      updateFields.tasbeehRecords   = merged;
      updateFields.earnedTasbeehXp  = earnedTasbeehXp;
      if (progressData.tasbeehTotals) {
        const oldTotals = oldUser.tasbeehTotals || {};
        const incomingTotals = progressData.tasbeehTotals || {};
        const mergedTotals = { ...oldTotals };
        for (const dhikrId in incomingTotals) {
          // берём максимум — защита от случайного уменьшения
          mergedTotals[dhikrId] = Math.max(
            oldTotals[dhikrId] || 0,
            incomingTotals[dhikrId] || 0
          );
        }
        updateFields.tasbeehTotals = mergedTotals;
      }
    }

    // XP — считаем САМИ, не берём с фронта
    updateFields.xp = (oldUser.xp || 0) + xpToAdd;

    // Глобальный стрик
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
      const currentStreak = hasActivityToday ? newStreak : (oldUser.currentStreak || 0);
      const streakMultiplier = Math.min(1 + (currentStreak * 0.1), 3.0);
      return { success: true, xpAdded: xpToAdd, streakMultiplier: xpToAdd > 0 ? streakMultiplier : 1.0, currentStreak };
    }
    return { success: true, xpAdded: 0, streakMultiplier: 1.0, currentStreak: oldUser.currentStreak || 0 };
  } catch (error) {
    console.error('❌ updateUserProgress ошибка:', error);
    throw error;
  }
}

/**
 * Получить полные данные для Mini App
 */
async function getUserFullData(userId) {
  try {
    const db = getDB();
    const user = await db.collection('users').findOne({ userId: parseInt(userId) });
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
      preparationProgress: user.preparationProgress || {},
      basicProgress: user.basicProgress || {},
      memorizedNames: user.memorizedNames || [],
      completedJuzs: user.completedJuzs || [],
      earnedJuzXpIds: user.earnedJuzXpIds || [],
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
      currentStreak: user.currentStreak || 0,
      longestStreak: user.longestStreak || 0,
      lastActiveDate: user.lastActiveDate || '',
      subscriptionExpiresAt: user.subscriptionExpiresAt || null,
      daysLeft: user.subscriptionExpiresAt
        ? Math.ceil((new Date(user.subscriptionExpiresAt) - new Date()) / (1000 * 60 * 60 * 24))
        : null,
      // ✅ ПОЛЯ v2
      dailyGoalRecords: user.dailyGoalRecords || {},
      goalCustomItems: user.goalCustomItems || {},
      goalStreaks: user.goalStreaks || {},
      tasbeehRecords: user.tasbeehRecords || {},
      tasbeehTotals: user.tasbeehTotals || {},
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
  const result = await users.updateOne({ userId }, { $set: { ...data, updatedAt: new Date() } });
  return result.modifiedCount > 0;
}

async function checkPromoCode(promoCode, userId) {
  const db = getDB();
  const users = db.collection('users');
  const normalizedCode = promoCode.toUpperCase();
  const owner = await users.findOne({ promoCode: normalizedCode });
  if (!owner) return { valid: false, reason: 'not_found' };
  if (owner.userId === userId) return { valid: false, reason: 'own_code' };
  if (owner.paymentStatus !== 'paid') return { valid: false, reason: 'owner_not_paid' };
  return { valid: true, owner };
}

async function updatePaymentStatus(userId, status, additionalData = {}) {
  const db = getDB();
  const users = db.collection('users');
  const result = await users.updateOne({ userId }, { $set: { paymentStatus: status, updatedAt: new Date(), ...additionalData } });
  console.log(`💳 Статус оплаты пользователя ${userId}: ${status}`);
  return result.modifiedCount > 0;
}

async function approvePayment(userId) {
  const db = getDB();
  const users = db.collection('users');
  const user = await users.findOne({ userId });
  const subscriptionExpiresAt = new Date();
  subscriptionExpiresAt.setDate(subscriptionExpiresAt.getDate() + 90);
  await users.updateOne({ userId }, {
    $set: {
      paymentStatus: 'paid', accessType: 'full', paymentDate: new Date(),
      subscriptionExpiresAt, subscriptionNotified3Days: false, subscriptionNotified1Day: false,
      onboardingCompleted: true, updatedAt: new Date()
    }
  });
  if (user.referredBy) {
    const referrer = await users.findOne({ promoCode: user.referredBy });
    if (referrer) await addReferralXP(referrer.userId, 'payment', userId, user.name);
  }
  return true;
}

async function rejectPayment(userId) {
  const db = getDB();
  const users = db.collection('users');
  const user = await users.findOne({ userId });
  let demoExpiresAt = null, accessType = null, demoStatus = 'none';
  if (user.accessType === 'demo' && user.demoExpiresAt && new Date() < new Date(user.demoExpiresAt)) {
    demoExpiresAt = user.demoExpiresAt; accessType = 'demo'; demoStatus = 'active';
  } else if (user.demoGivenOnRejection || user.demoActivatedManually) {
    demoStatus = 'none';
  } else {
    demoExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    accessType = 'demo'; demoStatus = 'given_new';
  }
  await users.updateOne({ userId }, {
    $set: { paymentStatus: 'unpaid', accessType, demoExpiresAt,
      demoGivenOnRejection: demoStatus === 'given_new' ? true : user.demoGivenOnRejection,
      updatedAt: new Date() }
  });
  return { demoStatus, demoExpiresAt };
}

async function getPendingPayments() {
  return await getDB().collection('users').find({ paymentStatus: 'pending' }).toArray();
}

async function checkDemoExpiration(userId) {
  const user = await getDB().collection('users').findOne({ userId });
  if (!user || user.accessType !== 'demo') return false;
  return new Date(user.demoExpiresAt) < new Date();
}

async function getUserAccess(userId) {
  const MAIN_ADMIN = parseInt(process.env.MAIN_ADMIN_ID);
  if (userId === MAIN_ADMIN) return { hasAccess: true, paymentStatus: 'paid', reason: 'admin_access' };
  const user = await getDB().collection('users').findOne({ userId });
  if (!user) return { hasAccess: false, paymentStatus: 'unpaid', reason: 'user_not_found' };
  if (user.accessType === 'demo' && user.demoExpiresAt) {
    const expiresAt = new Date(user.demoExpiresAt);
    if (expiresAt > new Date()) return { hasAccess: true, paymentStatus: 'demo', demoExpires: expiresAt.toISOString() };
    return { hasAccess: false, paymentStatus: 'unpaid', reason: 'demo_expired' };
  }
  if (user.paymentStatus === 'paid') {
    if (user.subscriptionExpiresAt) {
      const now = new Date(), expiresAt = new Date(user.subscriptionExpiresAt);
      if (now < expiresAt) {
        return { hasAccess: true, paymentStatus: 'paid', subscriptionExpires: user.subscriptionExpiresAt, daysLeft: Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)) };
      }
      return { hasAccess: false, paymentStatus: 'subscription_expired', reason: 'Подписка истекла', subscriptionExpired: true };
    }
    return { hasAccess: true, paymentStatus: 'paid', reason: 'legacy_user' };
  }
  if (user.paymentStatus === 'pending') {
    if (user.accessType === 'demo' && user.demoExpiresAt && new Date() < new Date(user.demoExpiresAt))
      return { hasAccess: true, paymentStatus: 'demo', demoExpires: user.demoExpiresAt, paymentPending: true };
    return { hasAccess: false, paymentStatus: 'pending', reason: 'payment_pending' };
  }
  if (user.paymentStatus === 'subscription_expired') return { hasAccess: false, paymentStatus: 'subscription_expired', reason: 'subscription_expired' };
  return { hasAccess: false, paymentStatus: 'unpaid', reason: 'not_paid' };
}

async function addUserXP(userId, amount, reason = '') {
  try {
    const result = await getDB().collection('users').updateOne(
      { userId: parseInt(userId) },
      { $inc: { xp: amount }, $set: { updatedAt: new Date() } }
    );
    if (result.modifiedCount > 0) {
      await checkAndUnlockBadges(userId);
      console.log(`✅ Добавлено ${amount} XP для userId ${userId}. Причина: ${reason}`);
      return true;
    }
    return false;
  } catch (error) { console.error('❌ addUserXP:', error); throw error; }
}

async function getGlobalLeaderboard(limit = 50) {
  try {
    return await getDB().collection('users').find({ paymentStatus: { $in: ['paid', 'demo'] }, xp: { $gt: 0 } })
      .sort({ xp: -1 }).limit(limit)
      .project({ userId: 1, username: 1, name: 1, photoUrl: 1, xp: 1, currentStreak: 1, unlockedBadges: 1, invitedCount: 1 })
      .toArray();
  } catch (error) { console.error('❌ getGlobalLeaderboard:', error); throw error; }
}

async function getUserRank(userId) {
  try {
    const users = getDB().collection('users');
    const user = await users.findOne({ userId: parseInt(userId) });
    if (!user) return { rank: null, totalUsers: 0 };
    const rank = await users.countDocuments({ paymentStatus: { $in: ['paid', 'demo'] }, xp: { $gt: user.xp } }) + 1;
    const totalUsers = await users.countDocuments({ paymentStatus: { $in: ['paid', 'demo'] }, xp: { $gt: 0 } });
    return { rank, totalUsers, userXP: user.xp };
  } catch (error) { console.error('❌ getUserRank:', error); throw error; }
}

async function getFriendsLeaderboard(userId, limit = 20) {
  try {
    const users = getDB().collection('users');
    const user = await users.findOne({ userId: parseInt(userId) });
    if (!user) return [];
    return await users.find({ referredBy: user.promoCode, paymentStatus: { $in: ['paid', 'demo'] } })
      .sort({ xp: -1 }).limit(limit)
      .project({ userId: 1, username: 1, name: 1, photoUrl: 1, xp: 1, currentStreak: 1, unlockedBadges: 1 })
      .toArray();
  } catch (error) { console.error('❌ getFriendsLeaderboard:', error); throw error; }
}

async function checkAndUnlockBadges(userId) {
  try {
    const users = getDB().collection('users');
    const user = await users.findOne({ userId });
    if (!user) return;
    const unlockedBadges = user.unlockedBadges || [];
    let newBadges = [...unlockedBadges];
    if ((user.invitedCount || 0) >= 10 && !newBadges.includes('social_butterfly')) newBadges.push('social_butterfly');
    const friendsLeaderboard = await getFriendsLeaderboard(userId, 20);
    if (friendsLeaderboard?.length > 0 && friendsLeaderboard[0].userId === userId && !newBadges.includes('friends_leader')) newBadges.push('friends_leader');
    if (user.xp >= 10000 && !newBadges.includes('legend')) newBadges.push('legend');
    if (newBadges.length > unlockedBadges.length) {
      await users.updateOne({ userId }, { $set: { unlockedBadges: newBadges } });
    }
    return newBadges;
  } catch (error) { console.error('Ошибка checkAndUnlockBadges:', error); return []; }
}

async function getCountries() {
  try {
    const countries = await getDB().collection('users').distinct('location.country', { 'location.country': { $ne: null }, onboardingCompleted: true });
    const norm = { 'Қазақстан': 'Kazakhstan', 'Ресей': 'Russia', 'Россия': 'Russia', 'Түркия': 'Turkey', 'Турция': 'Turkey', 'Өзбекстан': 'Uzbekistan', 'Узбекістан': 'Uzbekistan', 'Узбекистан': 'Uzbekistan' };
    return [...new Set(countries.map(c => norm[c] || c).filter(c => c && c !== 'Unknown'))].sort();
  } catch (error) { return []; }
}

async function getCities(country) {
  try {
    const cities = await getDB().collection('users').distinct('location.city', { 'location.country': country, 'location.city': { $ne: null }, onboardingCompleted: true });
    return cities.filter(c => c && c !== 'Unknown').sort();
  } catch (error) { return []; }
}

async function getFilteredLeaderboard(options = {}) {
  try {
    const { limit = 50, offset = 0, country = null, city = null } = options;
    const filter = { onboardingCompleted: true, xp: { $gt: 0 } };
    if (country) filter['location.country'] = country;
    if (city) filter['location.city'] = city;
    const leaderboard = await getDB().collection('users').find(filter).sort({ xp: -1 }).skip(offset).limit(limit)
      .project({ userId: 1, username: 1, name: 1, photoUrl: 1, xp: 1, currentStreak: 1, unlockedBadges: 1, invitedCount: 1, 'location.city': 1, 'location.country': 1 })
      .toArray();
    const total = await getDB().collection('users').countDocuments(filter);
    return { data: leaderboard, total, hasMore: offset + limit < total };
  } catch (error) { console.error('❌ getFilteredLeaderboard:', error); throw error; }
}

async function addReferralXP(userId, type = 'registration', referredUserId = null, referredUserName = null) {
  try {
    const now = new Date();
    // FIX #B3: используем getTodayStr для консистентности
    const user0 = await getDB().collection('users').findOne({ userId: parseInt(userId) });
    const refTz = user0?.location?.timezone || 'Asia/Almaty';
    const todayDateStr = getTodayStr(refTz);
    const eidDate = new Date('2026-03-20T23:59:59+05:00');
    if (now > eidDate) return { success: false, reason: 'period_ended' };
    const users = getDB().collection('users');
    const user = user0 || await users.findOne({ userId: parseInt(userId) });
    if (!user) return { success: false, reason: 'user_not_found' };
    let finalXP = 0, multiplier = 1.0, todayCount = 0;
    if (type === 'payment') {
      finalXP = 400;
    } else {
      const dailyReferrals = user.dailyReferrals || {};
      todayCount = (dailyReferrals[todayDateStr] || 0) + 1;
      if (todayCount >= 50) multiplier = 2.0;
      else if (todayCount >= 20) multiplier = 1.6;
      else if (todayCount >= 5) multiplier = 1.3;
      finalXP = Math.floor(100 * multiplier);
    }
    const updateData = { xp: (user.xp || 0) + finalXP, updatedAt: new Date() };
    if (type === 'registration') {
      updateData[`dailyReferrals.${todayDateStr}`] = todayCount;
      updateData.invitedCount = (user.invitedCount || 0) + 1;
    }
    await users.updateOne({ userId: parseInt(userId) }, { $set: updateData });
    return { success: true, xp: finalXP, multiplier: type === 'payment' ? 1.0 : multiplier, todayCount: type === 'registration' ? todayCount : 0, referredUserName, type };
  } catch (error) { console.error('❌ addReferralXP:', error); return { success: false, reason: 'error' }; }
}

export {
  getOrCreateUser, getUserById, getUserByPromoCode, incrementReferralCount,
  updateUserProgress, getUserFullData, updateUserOnboarding, checkPromoCode,
  updatePaymentStatus, approvePayment, rejectPayment, getUserAccess,
  getPendingPayments, checkDemoExpiration, addUserXP, getGlobalLeaderboard,
  getUserRank, getFriendsLeaderboard, getCountries, getCities,
  getFilteredLeaderboard, addReferralXP
};
