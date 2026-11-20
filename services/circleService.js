import { getDB } from '../db.js';
import {
  RAMADAN_START_DATE, PREPARATION_START_DATE, FIRST_TARAWEEH_DATE,
  EID_AL_FITR_DATE, RAMADAN_DAYS, PREPARATION_DAYS,
} from '../config.js';

// Генерация уникального ID круга
function generateCircleId() {
  return 'CRL_' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

// Генерация invite кода
function generateInviteCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function toValidUserId(id) {
  const parsed = parseInt(id, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('Invalid userId');
  }
  return parsed;
}

/**
 * Создать новый круг
 */
async function createCircle(ownerId, name, description = '', deps = {}) {
  try {
    const ownerUid = toValidUserId(ownerId);
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName || trimmedName.length > 50) {
      throw new Error('Circle name must be 1–50 characters');
    }
    const trimmedDesc = typeof description === 'string' ? description.trim() : '';
    if (trimmedDesc.length > 200) {
      throw new Error('Description must be 200 characters or fewer');
    }

    const db = deps.db || getDB();
    const circles = db.collection('circles');
    const users = db.collection('users');

    // Получаем данные создателя
    const owner = await users.findOne({ userId: ownerUid });
    
    if (!owner) {
      throw new Error('User not found');
    }
    
    const circleId = generateCircleId();
    let inviteCode = generateInviteCode();
    for (let attempt = 0; attempt < 10; attempt++) {
      const existing = await circles.findOne({ inviteCode });
      if (!existing) break;
      inviteCode = generateInviteCode();
    }
    const now = new Date().toISOString();
    
    const circle = {
      circleId,
      name: trimmedName,
      description: trimmedDesc,
      ownerId: ownerUid,
      members: [{
        userId: ownerUid,
        username: owner.username || '',
        name: owner.name || 'User',
        photoUrl: owner.photoUrl || '',
        role: 'owner',
        joinedAt: now,
        status: 'active'
      }],
      inviteCode,
      settings: {
        maxMembers: 10,
        isPrivate: true,
        showRealTimeProgress: true
      },
      createdAt: now,
      updatedAt: now
    };
    
    const result = await circles.insertOne(circle);
    
    console.log(`✅ Круг создан: ${trimmedName} (ID: ${circleId})`);
    
    return {
      success: true,
      circle: { ...circle, _id: result.insertedId }
    };
  } catch (error) {
    console.error('❌ Ошибка создания круга:', error);
    throw error;
  }
}

/**
 * Получить круги пользователя
 */
async function getUserCircles(userId, deps = {}) {
  try {
    const uid = toValidUserId(userId);
    const db = deps.db || getDB();
    const circles = db.collection('circles');
    
    // Получаем все круги где пользователь есть в members
    const allCircles = await circles.find({
      'members.userId': uid
    }).toArray();
    
    // Фильтруем только активные и pending (исключаем left, declined и removed)
    const activeCircles = allCircles.filter(circle => {
      const member = circle.members.find(m => Number(m.userId) === uid);
      return member && (member.status === 'active' || member.status === 'pending');
    });
    
    console.log(`✅ Найдено кругов для userId ${uid}: ${activeCircles.length}`);
    
    return activeCircles;
  } catch (error) {
    console.error('❌ Ошибка получения кругов:', error);
    return [];
  }
}

/**
 * Получить детали круга с real-time прогрессом
 */
async function getCircleDetails(circleId, requesterId, deps = {}) {
  try {
    const reqUid = toValidUserId(requesterId);
    const db = deps.db || getDB();
    const circles = db.collection('circles');
    const users = db.collection('users');
    
    const circle = await circles.findOne({ circleId });
    
    if (!circle) {
      throw new Error('Circle not found');
    }
    
    const isMember = circle.members.some(
      m => Number(m.userId) === reqUid && (m.status === 'active' || m.status === 'pending')
    );

    if (!isMember) {
      throw new Error('Access denied');
    }
    
    // Получаем прогресс каждого участника за сегодня (используем Almaty TZ как эталон)
    const now = new Date();
    const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Almaty' });
    // almatyTime нужен для сравнения с Date-объектами фаз
    const almatyTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));

    // Расчет текущего дня с учетом Almaty timezone
    const ramadanStart = new Date(RAMADAN_START_DATE + 'T00:00:00+05:00');
    const eidDate       = new Date(EID_AL_FITR_DATE  + 'T00:00:00+05:00');
    const preparationStart = new Date(PREPARATION_START_DATE + 'T00:00:00+05:00');

    // Три фазы: подготовка → Рамадан → базовая/Шавваль
    const isRamadanActive     = almatyTime >= ramadanStart && almatyTime < eidDate;
    const isPreparationActive = almatyTime >= preparationStart && almatyTime < ramadanStart;
    // После Ейда — базовая фаза, today (строка даты) используется как ключ

    let currentDayNumber;
    if (isRamadanActive) {
      const daysSinceRamadan = Math.floor((almatyTime - ramadanStart) / (1000 * 60 * 60 * 24));
      currentDayNumber = Math.max(1, Math.min(daysSinceRamadan + 1, RAMADAN_DAYS));
    } else if (isPreparationActive) {
      const daysSincePrep = Math.floor((almatyTime - preparationStart) / (1000 * 60 * 60 * 24));
      currentDayNumber = Math.max(1, Math.min(daysSincePrep + 1, PREPARATION_DAYS));
    } else {
      currentDayNumber = null; // базовая фаза — ключ это строка даты (today)
    }

    console.log('📅 ТЕКУЩАЯ ДАТА:', {
      almatyTime: almatyTime.toISOString(),
      today,
      isRamadanActive,
      isPreparationActive,
      currentDayNumber,
    });

    const membersWithProgress = await Promise.all(
      circle.members
        .filter(m => m.status === 'active')
        .map(async (member) => {
          const user = await users.findOne({ userId: member.userId });

          if (!user) return null;

          const prepProgress    = user.preparationProgress || {};
          const ramadanProgress = user.progress || {};
          const basicProgress   = user.basicProgress || {};

          // Баг 1 исправлен: Рамадан-прогресс хранится по числовому ключу (1, 2, ..., 29),
          // не по строке 'day_N'. Базовая фаза — по строке даты (today = 'YYYY-MM-DD').
          let dailyProgress;
          if (isRamadanActive) {
            dailyProgress = ramadanProgress[currentDayNumber] || {};
          } else if (isPreparationActive) {
            dailyProgress = prepProgress[currentDayNumber] || {};
          } else {
            dailyProgress = basicProgress[today] || {};
          }

          // Список задач по фазе
          let tasks;
          if (isRamadanActive) {
            tasks = ['fasting', 'fajr', 'duha', 'dhuhr', 'asr', 'maghrib', 'isha', 'quranRead', 'morningDhikr', 'eveningDhikr'];
          } else if (isPreparationActive) {
            // Задачи подготовки - базовые (12 задач)
            tasks = [
              'fajr', 'duha', 'dhuhr', 'asr', 'maghrib', 'isha',
              'morningDhikr', 'eveningDhikr', 'quranRead',
              'salawat', 'hadith', 'charity'
            ];
            const dayOfWeek = almatyTime.getDay();
            const isMondayOrThursday = dayOfWeek === 1 || dayOfWeek === 4;
            const firstTaraweehDate = new Date(FIRST_TARAWEEH_DATE + 'T00:00:00+05:00');
            const isFirstTaraweehDay = almatyTime.toDateString() === firstTaraweehDate.toDateString();
            if (isMondayOrThursday) tasks.push('fasting');
            if (isFirstTaraweehDay) tasks.push('taraweeh');
          } else {
            // Базовая/Шавваль фаза — те же 12 задач без условных
            tasks = [
              'fajr', 'duha', 'dhuhr', 'asr', 'maghrib', 'isha',
              'morningDhikr', 'eveningDhikr', 'quranRead',
              'salawat', 'charity', 'book'
            ];
          }
          const completed = tasks.filter(task => dailyProgress[task]).length;
          const progressPercent = Math.round((completed / tasks.length) * 100);
          
          return {
            userId: member.userId,
            username: member.username,
            name: member.name,
            photoUrl: member.photoUrl,
            role: member.role,
            xp: user.xp || 0,
            currentStreak: user.currentStreak || 0,
            customTasks: Array.isArray(user.customTasks)
              ? user.customTasks.map(t => ({ id: t.id, text: t.text, completed: !!t.completed }))
              : [],
            todayProgress: {
              percent: progressPercent,
              completed: completed,
              total: tasks.length,
              tasks: dailyProgress
            }
          };
        })
    );
    
    return {
      ...circle,
      membersWithProgress: membersWithProgress.filter(m => m !== null)
    };
  } catch (error) {
    console.error('❌ Ошибка получения деталей круга:', error);
    throw error;
  }
}

/**
 * Отправить приглашение в круг (по username)
 */
async function inviteToCircle(circleId, inviterId, targetUsername, deps = {}) {
  try {
    const inviterUid = toValidUserId(inviterId);
    if (typeof targetUsername !== 'string' || !targetUsername.trim()) {
      throw new Error('Username is required');
    }
    const rawClean = targetUsername.trim().replace(/^@+/, '');
    if (!rawClean) {
      throw new Error('Username is required');
    }

    const db = deps.db || getDB();
    const circles = db.collection('circles');
    const users = db.collection('users');
    
    const circle = await circles.findOne({ circleId });
    
    if (!circle) {
      throw new Error('Circle not found');
    }
    
    // Проверяем что приглашающий - владелец
    if (Number(circle.ownerId) !== inviterUid) {
      throw new Error('Only owner can invite');
    }
    
    // Проверяем лимит участников
    const maxMembers = circle.settings?.maxMembers || 10;
    if (circle.members.filter(m => m.status === 'active').length >= maxMembers) {
      throw new Error('Circle is full');
    }
    
    // Ищем пользователя по username — один запрос с case-insensitive regex (с @ и без)
    const cleanUsername = rawClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const targetUser = await users.findOne({
      username: { $regex: new RegExp(`^@?${cleanUsername}$`, 'i') }
    });

    if (!targetUser) {
      throw new Error('User not found');
    }

    const targetUid = Number(targetUser.userId);
    if (targetUid === inviterUid) {
      throw new Error('Cannot invite yourself');
    }
    
    // Проверяем существующую запись участника — не допускаем дубликатов в массиве members
    const existingMember = circle.members.find(m => Number(m.userId) === targetUid);
    if (existingMember && (existingMember.status === 'active' || existingMember.status === 'pending')) {
      throw new Error('User is already a member or has pending invite');
    }
    
    const now = new Date().toISOString();
    
    if (existingMember) {
      // Повторное приглашение ранее вышедшего/отклонившего/исключённого пользователя:
      // обновляем запись на месте через $elemMatch без дублирования в members.
      const reactivateRes = await circles.updateOne(
        {
          circleId,
          members: { $elemMatch: { userId: targetUid, status: { $in: ['left', 'declined', 'removed'] } } }
        },
        {
          $set: {
            'members.$.username': targetUser.username || '',
            'members.$.name': targetUser.name || 'User',
            'members.$.photoUrl': targetUser.photoUrl || '',
            'members.$.role': 'member',
            'members.$.joinedAt': now,
            'members.$.status': 'pending',
            updatedAt: now
          }
        }
      );
      if (reactivateRes.modifiedCount === 0) {
        throw new Error('User is already a member or has pending invite');
      }
    } else {
      // Атомарно добавляем нового участника только если его ещё нет в members
      const pushRes = await circles.updateOne(
        { circleId, 'members.userId': { $ne: targetUid } },
        {
          $push: {
            members: {
              userId: targetUid,
              username: targetUser.username || '',
              name: targetUser.name || 'User',
              photoUrl: targetUser.photoUrl || '',
              role: 'member',
              joinedAt: now,
              status: 'pending'
            }
          },
          $set: { updatedAt: now }
        }
      );
      if (pushRes.modifiedCount === 0) {
        throw new Error('User is already a member or has pending invite');
      }
    }
    
    console.log(`✅ Приглашение отправлено: ${targetUsername} → ${circle.name}`);
    
    return { 
      success: true,
      targetUserId: targetUid,
      circleName: circle.name,
      circleDescription: circle.description,
      memberCount: circle.members.filter(m => m.status === 'active').length,
      inviterUsername: circle.members.find(m => Number(m.userId) === inviterUid)?.username || 'Someone'
    };
  } catch (error) {
    console.error('❌ Ошибка приглашения:', error);
    throw error;
  }
}


/**
 * Принять приглашение
 */
async function acceptInvite(circleId, userId, deps = {}) {
  try {
    const uid = toValidUserId(userId);
    const db = deps.db || getDB();
    const circles = db.collection('circles');

    const circle = await circles.findOne({ circleId });
    if (!circle) {
      throw new Error('Invite not found');
    }
    const maxMembers = circle.settings?.maxMembers || 10;
    const activeCount = circle.members.filter(m => m.status === 'active').length;
    if (activeCount >= maxMembers) {
      throw new Error('Circle is full');
    }
    
    // $elemMatch гарантирует совпадение userId и status === 'pending' в одном элементе массива
    const result = await circles.updateOne(
      {
        circleId,
        members: { $elemMatch: { userId: uid, status: 'pending' } }
      },
      {
        $set: {
          'members.$.status': 'active',
          'members.$.joinedAt': new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      }
    );
    
    if (result.modifiedCount === 0) {
      throw new Error('Invite not found');
    }
    
    console.log(`✅ Приглашение принято: userId=${uid}, circleId=${circleId}`);
    
    return { success: true };
  } catch (error) {
    console.error('❌ Ошибка принятия приглашения:', error);
    throw error;
  }
}

/**
 * Отклонить приглашение
 */
async function declineInvite(circleId, userId, deps = {}) {
  try {
    const uid = toValidUserId(userId);
    const db = deps.db || getDB();
    const circles = db.collection('circles');
    
    // $elemMatch гарантирует совпадение userId и status === 'pending' в одном элементе массива
    const result = await circles.updateOne(
      {
        circleId,
        members: { $elemMatch: { userId: uid, status: 'pending' } }
      },
      {
        $set: {
          'members.$.status': 'declined',
          updatedAt: new Date().toISOString()
        }
      }
    );
    
    if (result.modifiedCount === 0) {
      throw new Error('Invite not found');
    }
    
    console.log(`❌ Пользователь ${uid} отклонил приглашение в круг ${circleId}`);
    
    return { success: true, message: 'Invitation declined' };
  } catch (error) {
    console.error('❌ Ошибка отклонения приглашения:', error);
    throw error;
  }
}

/**
 * Присоединиться к кругу по invite коду
 */
async function joinByCode(inviteCode, userId, deps = {}) {
  try {
    const uid = toValidUserId(userId);
    const normalizedCode = typeof inviteCode === 'string' ? inviteCode.trim().toUpperCase() : '';
    if (!normalizedCode) {
      throw new Error('Circle not found');
    }

    const db = deps.db || getDB();
    const circles = db.collection('circles');
    const users = db.collection('users');
    
    // Находим круг по коду
    const circle = await circles.findOne({ inviteCode: normalizedCode });
    
    if (!circle) {
      throw new Error('Circle not found');
    }
    
    // Проверяем существующую запись участника
    const existingMember = circle.members.find(m => Number(m.userId) === uid);
    
    if (existingMember) {
      if (existingMember.status === 'active') {
        throw new Error('Already a member');
      }
      if (existingMember.status === 'removed') {
        throw new Error('You were removed from this circle');
      }
    }

    // Проверяем лимит участников до реактивации и до добавления нового участника
    const maxMembers = circle.settings?.maxMembers || 10;
    const activeCount = circle.members.filter(m => m.status === 'active').length;
    if (activeCount >= maxMembers) {
      throw new Error('Circle is full');
    }

    const now = new Date().toISOString();

    if (existingMember) {
      // Если был pending, declined или left — атомарно активируем
      const reactivateRes = await circles.updateOne(
        {
          circleId: circle.circleId,
          members: { $elemMatch: { userId: uid, status: { $in: ['pending', 'declined', 'left'] } } }
        },
        {
          $set: {
            'members.$.status': 'active',
            'members.$.joinedAt': now,
            updatedAt: now
          }
        }
      );
      if (reactivateRes.modifiedCount === 0) {
        throw new Error('Already a member');
      }
      
      const updatedCircle = await circles.findOne({ circleId: circle.circleId }) || circle;
      console.log(`✅ Пользователь ${uid} присоединился к кругу ${circle.name} (реактивация)`);
      
      return { success: true, circle: updatedCircle };
    }
    
    // Получаем данные пользователя
    const user = await users.findOne({ userId: uid });
    
    if (!user) {
      throw new Error('User not found');
    }
    
    // Атомарно добавляем нового участника с защитой от дублирующегося вступления
    const pushRes = await circles.updateOne(
      { circleId: circle.circleId, 'members.userId': { $ne: uid } },
      {
        $push: {
          members: {
            userId: uid,
            username: user.username || '',
            name: user.name || 'User',
            photoUrl: user.photoUrl || '',
            role: 'member',
            joinedAt: now,
            status: 'active'
          }
        },
        $set: { updatedAt: now }
      }
    );
    if (pushRes.modifiedCount === 0) {
      throw new Error('Already a member');
    }
    
    const updatedCircle = await circles.findOne({ circleId: circle.circleId }) || circle;
    console.log(`✅ Пользователь ${uid} присоединился к кругу ${circle.name} по коду ${normalizedCode}`);
    
    return { success: true, circle: updatedCircle };
  } catch (error) {
    console.error('❌ Ошибка присоединения по коду:', error);
    throw error;
  }
}

// Выйти из круга
async function leaveCircle(circleId, userId, deps = {}) {
  try {
    const uid = toValidUserId(userId);
    const db = deps.db || getDB();
    const circles = db.collection('circles');
    
    console.log(`🚪 Попытка выхода: userId=${uid}, circleId=${circleId}`);
    
    // Получаем круг
    const circle = await circles.findOne({ circleId });
    
    if (!circle) {
      throw new Error('Circle not found');
    }
    
    // Единственный владелец не может выйти из круга — должен удалить круг
    const memberRecord = circle.members.find(m => Number(m.userId) === uid);
    if (Number(circle.ownerId) === uid || memberRecord?.role === 'owner') {
      throw new Error('Owner cannot leave the circle. Delete the circle instead.');
    }
    
    // Атомарно меняем статус на 'left' через $elemMatch
    const result = await circles.updateOne(
      {
        circleId,
        members: { $elemMatch: { userId: uid, status: { $in: ['active', 'pending'] } } }
      },
      {
        $set: {
          'members.$.status': 'left',
          'members.$.leftAt': new Date(),
          updatedAt: new Date().toISOString()
        }
      }
    );
    
    if (result.modifiedCount === 0) {
      throw new Error('You are not a member of this circle');
    }
    
    console.log(`✅ Пользователь ${uid} вышел из круга ${circleId}`);
    
    return { success: true };
  } catch (error) {
    console.error('❌ Ошибка выхода из круга:', error);
    throw error;
  }
}

// Удалить участника из круга (kick)
async function removeMember(circleId, ownerId, targetUserId, deps = {}) {
  try {
    const ownerUid = toValidUserId(ownerId);
    const targetUid = toValidUserId(targetUserId);
    const db = deps.db || getDB();
    const circles = db.collection('circles');
    
    console.log(`🗑️ Попытка удаления участника: ownerId=${ownerUid}, targetUserId=${targetUid}, circleId=${circleId}`);
    
    // Получаем круг
    const circle = await circles.findOne({ circleId });
    
    if (!circle) {
      throw new Error('Circle not found');
    }
    
    // Проверяем что запрашивающий - владелец
    if (Number(circle.ownerId) !== ownerUid) {
      throw new Error('Only owner can remove members');
    }
    
    // Нельзя удалить самого себя
    if (targetUid === ownerUid) {
      throw new Error('Cannot remove yourself. Delete the circle instead.');
    }
    
    // Атомарно меняем статус активного или приглашённого участника на 'removed'
    const result = await circles.updateOne(
      {
        circleId,
        members: { $elemMatch: { userId: targetUid, status: { $in: ['active', 'pending'] } } }
      },
      {
        $set: {
          'members.$.status': 'removed',
          'members.$.removedAt': new Date(),
          updatedAt: new Date().toISOString()
        }
      }
    );
    
    if (result.modifiedCount === 0) {
      throw new Error('Member not found');
    }
    
    console.log(`✅ Участник ${targetUid} удален из круга ${circleId}`);
    
    return { success: true };
  } catch (error) {
    console.error('❌ Ошибка удаления участника:', error);
    throw error;
  }
}


// Удалить круг полностью
async function deleteCircle(circleId, ownerId, deps = {}) {
  try {
    const ownerUid = toValidUserId(ownerId);
    const db = deps.db || getDB();
    const circles = db.collection('circles');
    
    console.log(`🗑️ Попытка удаления круга: ownerId=${ownerUid}, circleId=${circleId}`);
    
    // Получаем круг
    const circle = await circles.findOne({ circleId });
    
    if (!circle) {
      throw new Error('Circle not found');
    }
    
    // Проверяем что запрашивающий - владелец
    if (Number(circle.ownerId) !== ownerUid) {
      throw new Error('Only owner can delete the circle');
    }
    
    // Атомарно удаляем круг только при совпадении ownerId
    await circles.deleteOne({ circleId, ownerId: ownerUid });
    
    console.log(`✅ Круг ${circleId} удален`);
    
    return { success: true };
  } catch (error) {
    console.error('❌ Ошибка удаления круга:', error);
    throw error;
  }
}


export {
  createCircle,
  getUserCircles,
  getCircleDetails,
  inviteToCircle,
  acceptInvite,
  declineInvite,
  joinByCode,
  leaveCircle,
  removeMember,
  deleteCircle
};
