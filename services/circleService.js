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
    const db = await getDB();
    const circles = db.collection('circles');
    
    // Получаем все круги где пользователь есть в members
    const allCircles = await circles.find({
      'members.userId': parseInt(userId)
    }).toArray();
    
    // Фильтруем только активные и pending (исключаем left и declined)
    const activeCircles = allCircles.filter(circle => {
      const member = circle.members.find(m => 
        m.userId === parseInt(userId) || m.userId === userId
      );
      return member && (member.status === 'active' || member.status === 'pending');
    });
    
    console.log(`✅ Найдено кругов для userId ${userId}: ${activeCircles.length}`);
    
    return activeCircles;
  } catch (error) {
    console.error('❌ Ошибка получения кругов:', error);
    return [];
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
        // Разрешаем доступ для active и pending (чтобы видеть детали перед принятием)
        const match = (m.userId === parseInt(requesterId) || m.userId === requesterId) && 
                      (m.status === 'active' || m.status === 'pending');
        console.log('🔍 Сравнение:', {
          memberUserId: m.userId,
          requesterId,
          status: m.status,
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
    const almatyOffset = 5 * 60; // +5 часов в минутах
    const now = new Date();
    const almatyTime = new Date(now.getTime() + (almatyOffset + now.getTimezoneOffset()) * 60000);
    const today = almatyTime.toISOString().split('T')[0];

    // Правильный расчет текущего дня с учетом Almaty timezone
    const ramadanStart = new Date('2026-02-19T00:00:00+05:00');
    const preparationStart = new Date('2026-02-09T00:00:00+05:00');

    const isRamadanStarted = almatyTime >= ramadanStart;
    const isPreparationStarted = almatyTime >= preparationStart;

    let currentDayNumber;
    if (isRamadanStarted) {
      // Рамадан начался - считаем дни Рамадана
      const daysSinceRamadan = Math.floor((almatyTime - ramadanStart) / (1000 * 60 * 60 * 24));
      currentDayNumber = Math.max(1, Math.min(daysSinceRamadan + 1, 30));
    } else if (isPreparationStarted) {
      // Подготовка - считаем дни подготовки
      const daysSincePrep = Math.floor((almatyTime - preparationStart) / (1000 * 60 * 60 * 24));
      currentDayNumber = Math.max(1, Math.min(daysSincePrep + 1, 10));
    } else {
      // До подготовки
      currentDayNumber = 1;
    }

    const todayKey = `day_${currentDayNumber}`;

    console.log('📅 ТЕКУЩАЯ ДАТА:', {
      almatyTime: almatyTime.toISOString(),
      today,
      isRamadanStarted,
      isPreparationStarted,
      currentDayNumber,
      todayKey
    });

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
          const dailyProgress = isRamadanStarted 
            ? ramadanProgress[todayKey] || {}
            : prepProgress[todayKey] || {};
          
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
    
    // ✅ ИЗМЕНИТЬ: Возвращаем данные для отправки уведомления
    return { 
      success: true,
      targetUserId: targetUser.userId,
      circleName: circle.name,
      circleDescription: circle.description,
      memberCount: circle.members.filter(m => m.status === 'active').length,
      inviterUsername: circle.members.find(m => m.userId === parseInt(inviterId))?.username || 'Someone'
    };
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

/**
 * Отклонить приглашение
 */
async function declineInvite(circleId, userId) {
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
          'members.$.status': 'declined',
          updatedAt: new Date().toISOString()
        }
      }
    );
    
    if (result.modifiedCount === 0) {
      throw new Error('Invite not found');
    }
    
    console.log(`❌ Пользователь ${userId} отклонил приглашение в круг ${circleId}`);
    
    return { success: true, message: 'Invitation declined' };
  } catch (error) {
    console.error('❌ Ошибка отклонения приглашения:', error);
    throw error;
  }
}

/**
 * Присоединиться к кругу по invite коду
 */
async function joinByCode(inviteCode, userId) {
  try {
    const db = getDB();
    const circles = db.collection('circles');
    const users = db.collection('users');
    
    // Находим круг по коду
    const circle = await circles.findOne({ inviteCode: inviteCode.toUpperCase() });
    
    if (!circle) {
      throw new Error('Circle not found');
    }
    
    // Проверяем не состоит ли уже
    const existingMember = circle.members.find(m => m.userId === parseInt(userId));
    
    if (existingMember) {
      if (existingMember.status === 'active') {
        throw new Error('Already a member');
      }
      
      // Если был pending или declined - активируем
      await circles.updateOne(
        { 
          circleId: circle.circleId,
          'members.userId': parseInt(userId)
        },
        {
          $set: {
            'members.$.status': 'active',
            'members.$.joinedAt': new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        }
      );
      
      console.log(`✅ Пользователь ${userId} присоединился к кругу ${circle.name} (реактивация)`);
      
      return { success: true, circle };
    }
    
    // Проверяем лимит
    const activeCount = circle.members.filter(m => m.status === 'active').length;
    if (activeCount >= circle.settings.maxMembers) {
      throw new Error('Circle is full');
    }
    
    // Получаем данные пользователя
    const user = await users.findOne({ userId: parseInt(userId) });
    
    if (!user) {
      throw new Error('User not found');
    }
    
    // Добавляем нового участника
    const now = new Date().toISOString();
    
    await circles.updateOne(
      { circleId: circle.circleId },
      {
        $push: {
          members: {
            userId: parseInt(userId),
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
    
    console.log(`✅ Пользователь ${userId} присоединился к кругу ${circle.name} по коду ${inviteCode}`);
    
    return { success: true, circle };
  } catch (error) {
    console.error('❌ Ошибка присоединения по коду:', error);
    throw error;
  }
}

// Выйти из круга
async function leaveCircle(circleId, userId) {
  try {
    const db = await getDB();
    const circles = db.collection('circles');
    
    console.log(`🚪 Попытка выхода: userId=${userId}, circleId=${circleId}`);
    
    // Получаем круг
    const circle = await circles.findOne({ circleId });
    
    if (!circle) {
      throw new Error('Circle not found');
    }
    
    // Проверяем что пользователь не владелец
    if (circle.ownerId === parseInt(userId)) {
      throw new Error('Owner cannot leave the circle. Delete the circle instead.');
    }
    
    // Проверяем что пользователь участник
    const memberIndex = circle.members.findIndex(
      m => (m.userId === parseInt(userId) || m.userId === userId) && 
           (m.status === 'active' || m.status === 'pending')
    );
    
    if (memberIndex === -1) {
      throw new Error('You are not a member of this circle');
    }
    
    // Меняем статус на 'left'
    await circles.updateOne(
      { circleId },
      { 
        $set: { 
          [`members.${memberIndex}.status`]: 'left',
          [`members.${memberIndex}.leftAt`]: new Date()
        } 
      }
    );
    
    console.log(`✅ Пользователь ${userId} вышел из круга ${circleId}`);
    
    return { success: true };
  } catch (error) {
    console.error('❌ Ошибка выхода из круга:', error);
    throw error;
  }
}

// Удалить участника из круга (kick)
async function removeMember(circleId, ownerId, targetUserId) {
  try {
    const db = await getDB();
    const circles = db.collection('circles');
    
    console.log(`🗑️ Попытка удаления участника: ownerId=${ownerId}, targetUserId=${targetUserId}, circleId=${circleId}`);
    
    // Получаем круг
    const circle = await circles.findOne({ circleId });
    
    if (!circle) {
      throw new Error('Circle not found');
    }
    
    // Проверяем что запрашивающий - владелец
    if (circle.ownerId !== parseInt(ownerId)) {
      throw new Error('Only owner can remove members');
    }
    
    // Нельзя удалить самого себя
    if (parseInt(targetUserId) === parseInt(ownerId)) {
      throw new Error('Cannot remove yourself. Delete the circle instead.');
    }
    
    // Находим участника
    const memberIndex = circle.members.findIndex(
      m => (m.userId === parseInt(targetUserId) || m.userId === targetUserId)
    );
    
    if (memberIndex === -1) {
      throw new Error('Member not found');
    }
    
    // Меняем статус на 'removed'
    await circles.updateOne(
      { circleId },
      { 
        $set: { 
          [`members.${memberIndex}.status`]: 'removed',
          [`members.${memberIndex}.removedAt`]: new Date()
        } 
      }
    );
    
    console.log(`✅ Участник ${targetUserId} удален из круга ${circleId}`);
    
    return { success: true };
  } catch (error) {
    console.error('❌ Ошибка удаления участника:', error);
    throw error;
  }
}


// Удалить круг полностью
async function deleteCircle(circleId, ownerId) {
  try {
    const db = await getDB();
    const circles = db.collection('circles');
    
    console.log(`🗑️ Попытка удаления круга: ownerId=${ownerId}, circleId=${circleId}`);
    
    // Получаем круг
    const circle = await circles.findOne({ circleId });
    
    if (!circle) {
      throw new Error('Circle not found');
    }
    
    // Проверяем что запрашивающий - владелец
    if (circle.ownerId !== parseInt(ownerId)) {
      throw new Error('Only owner can delete the circle');
    }
    
    // Удаляем круг
    await circles.deleteOne({ circleId });
    
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
