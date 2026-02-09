import { getDB } from '../db.js';

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

/**
 * Создать новый круг
 */
async function createCircle(ownerId, name, description = '') {
  try {
    const db = getDB();
    const circles = db.collection('circles');
    const users = db.collection('users');
    
    // Получаем данные создателя
    const owner = await users.findOne({ userId: parseInt(ownerId) });
    
    if (!owner) {
      throw new Error('User not found');
    }
    
    // Проверяем - не создал ли уже круг
    const existingCircle = await circles.findOne({
      ownerId: parseInt(ownerId),
      'members.status': 'active'
    });
    
    if (existingCircle) {
      throw new Error('You already have an active circle');
    }
    
    const circleId = generateCircleId();
    const inviteCode = generateInviteCode();
    const now = new Date().toISOString();
    
    const circle = {
      circleId,
      name,
      description,
      ownerId: parseInt(ownerId),
      members: [{
        userId: parseInt(ownerId),
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
    
    console.log(`✅ Круг создан: ${name} (ID: ${circleId})`);
    
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
async function getUserCircles(userId) {
  try {
    const db = getDB();
    const circles = db.collection('circles');
    
    const userCircles = await circles.find({
      'members.userId': parseInt(userId),
      'members.status': 'active'
    }).toArray();
    
    return userCircles;
  } catch (error) {
    console.error('❌ Ошибка получения кругов:', error);
    throw error;
  }
}

/**
 * Получить детали круга с real-time прогрессом
 */
async function getCircleDetails(circleId, requesterId) {
  try {
    const db = getDB();
    const circles = db.collection('circles');
    const users = db.collection('users');
    
    const circle = await circles.findOne({ circleId });
    
    if (!circle) {
      throw new Error('Circle not found');
    }
    
    // Проверяем что запрашивающий - участник
    console.log('🔍 Проверка доступа к кругу:', {
      circleId,
      requesterId,
      requesterIdType: typeof requesterId,
      members: circle.members.map(m => ({ 
        userId: m.userId, 
        userIdType: typeof m.userId,
        status: m.status 
      }))
    });

    const isMember = circle.members.some(
      m => {
        const match = (m.userId === parseInt(requesterId) || m.userId === requesterId) && m.status === 'active';
        console.log('🔍 Сравнение:', {
          memberUserId: m.userId,
          requesterId,
          parsed: parseInt(requesterId),
          match
        });
        return match;
      }
    );

    console.log('🔍 isMember:', isMember);

    if (!isMember) {
      throw new Error('Access denied');
    }
    
    // Получаем прогресс каждого участника за сегодня
    const today = new Date().toISOString().split('T')[0];
    const todayKey = `day_${Math.floor((new Date() - new Date('2026-02-19')) / (1000 * 60 * 60 * 24)) + 1}`;
    
    const membersWithProgress = await Promise.all(
      circle.members
        .filter(m => m.status === 'active')
        .map(async (member) => {
          const user = await users.findOne({ userId: member.userId });
          
          if (!user) return null;
          
          // Прогресс подготовки (если Рамадан не начался)
          const prepProgress = user.preparationProgress || {};
          const ramadanProgress = user.progress || {};
          
          // Определяем какой прогресс показывать
          const isRamadanStarted = new Date() >= new Date('2026-02-19');
          const dailyProgress = isRamadanStarted 
            ? ramadanProgress[todayKey] || {}
            : prepProgress[1] || {};  // Пока показываем день 1 подготовки
          
          // Считаем процент выполнения
          const tasks = ['fasting', 'fajr', 'duha', 'dhuhr', 'asr', 'maghrib', 'isha', 'quranRead', 'morningDhikr', 'eveningDhikr'];
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
async function inviteToCircle(circleId, inviterId, targetUsername) {
  try {
    const db = getDB();
    const circles = db.collection('circles');
    const users = db.collection('users');
    
    const circle = await circles.findOne({ circleId });
    
    if (!circle) {
      throw new Error('Circle not found');
    }
    
    // Проверяем что приглашающий - владелец
    if (circle.ownerId !== parseInt(inviterId)) {
      throw new Error('Only owner can invite');
    }
    
    // Проверяем лимит участников
    if (circle.members.filter(m => m.status === 'active').length >= circle.settings.maxMembers) {
      throw new Error('Circle is full');
    }
    
    // Ищем пользователя по username (с @ и без)
    const cleanUsername = targetUsername.replace('@', '');

    console.log('🔍 Ищем пользователя:', {
      original: targetUsername,
      cleaned: cleanUsername
    });

    // Пробуем найти с @
    let targetUser = await users.findOne({ username: `@${cleanUsername}` });

    // Если не нашли - пробуем без @
    if (!targetUser) {
      targetUser = await users.findOne({ username: cleanUsername });
    }

    // Если не нашли - пробуем case-insensitive
    if (!targetUser) {
      targetUser = await users.findOne({
        username: { $regex: new RegExp(`^@?${cleanUsername}$`, 'i') }
      });
    }

    if (!targetUser) {
      // Покажем примеры для отладки
      const samples = await users.find({}).limit(3).project({ username: 1, userId: 1 }).toArray();
      console.log('❌ Пользователь не найден. Примеры в базе:', samples);
      throw new Error('User not found');
    }

    console.log('✅ Пользователь найден:', {
      userId: targetUser.userId,
      username: targetUser.username
    });
    
    // Проверяем не состоит ли уже
    const alreadyMember = circle.members.some(
      m => m.userId === targetUser.userId && m.status !== 'removed'
    );
    
    if (alreadyMember) {
      throw new Error('User is already a member or has pending invite');
    }
    
    // Добавляем со статусом pending
    const now = new Date().toISOString();
    
    await circles.updateOne(
      { circleId },
      {
        $push: {
          members: {
            userId: targetUser.userId,
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
    
    console.log(`✅ Приглашение отправлено: ${targetUsername} → ${circle.name}`);
    
    return { success: true };
  } catch (error) {
    console.error('❌ Ошибка приглашения:', error);
    throw error;
  }
}

/**
 * Принять приглашение
 */
async function acceptInvite(circleId, userId) {
  try {
    const db = getDB();
    const circles = db.collection('circles');
    
    const result = await circles.updateOne(
      { 
        circleId,
        'members.userId': parseInt(userId),
        'members.status': 'pending'
      },
      {
        $set: {
          'members.$.status': 'active',
          updatedAt: new Date().toISOString()
        }
      }
    );
    
    if (result.modifiedCount === 0) {
      throw new Error('Invite not found');
    }
    
    console.log(`✅ Приглашение принято: userId=${userId}, circleId=${circleId}`);
    
    return { success: true };
  } catch (error) {
    console.error('❌ Ошибка принятия приглашения:', error);
    throw error;
  }
}

export {
  createCircle,
  getUserCircles,
  getCircleDetails,
  inviteToCircle,
  acceptInvite
};
