// db.js
import { MongoClient } from 'mongodb';

// Поддержка Railway MongoDB (MONGO_URL) и MongoDB Atlas (MONGODB_URI)
const connectionString = process.env.MONGO_URI || process.env.MONGO_URL || process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'imantap_db';

if (!connectionString) {
  throw new Error('MONGO_URL или MONGODB_URI должна быть установлена в переменных окружения');
}

const client = new MongoClient(connectionString, {
  serverSelectionTimeoutMS: 5000,
  maxPoolSize: 50,
  minPoolSize: 5,
  maxIdleTimeMS: 30000,
  retryWrites: true,
  retryReads: true
});

let db;

export async function connectDB() {
  try {
    console.log('🔄 Подключение к MongoDB...');
    await client.connect();
    db = client.db(dbName);
    console.log('✅ MongoDB успешно подключена');
    console.log(`📦 База данных: ${dbName}`);
  } catch (error) {
    console.error('❌ Ошибка подключения к MongoDB:', error.message);
    process.exit(1);
  }
}

export function getDB() {
  if (!db) {
    throw new Error('База данных не подключена. Вызовите connectDB() сначала.');
  }
  return db;
}

/**
 * Создать индексы для оптимизации
 */
export async function createIndexes() {
  console.log('📊 Создание индексов...');
  
  const db = getDB();
  
  // Users collection
  const users = db.collection('users');
  
  try {
    // ✅ Основные индексы
    await users.createIndex({ userId: 1 }, { unique: true });
    console.log('✅ Index: userId');
    
    await users.createIndex({ promoCode: 1 }, { unique: true });
    console.log('✅ Index: promoCode');
    
    // ✅ Индексы для поиска
    await users.createIndex({ username: 1 });
    console.log('✅ Index: username');
    
    await users.createIndex({ phoneNumber: 1 });
    console.log('✅ Index: phoneNumber');
    
    // ✅ Индексы для фильтрации
    await users.createIndex({ paymentStatus: 1 });
    console.log('✅ Index: paymentStatus');

    await users.createIndex({ xp: -1 });
    console.log('✅ Index: xp');

    await users.createIndex({ referredBy: 1 });
    console.log('✅ Index: referredBy');
    
    await users.createIndex({ onboardingCompleted: 1 });
    console.log('✅ Index: onboardingCompleted');
    
    // ✅ Индексы для времен намазов
    await users.createIndex({ 'prayerTimes.fajr': 1 });
    console.log('✅ Index: prayerTimes.fajr');
    
    await users.createIndex({ 'prayerTimes.maghrib': 1 });
    console.log('✅ Index: prayerTimes.maghrib');
    
    // ✅ Индексы для demo режима
    await users.createIndex({ demoExpiresAt: 1 });
    console.log('✅ Index: demoExpiresAt');
    
    await users.createIndex({ accessType: 1 });
    console.log('✅ Index: accessType');
    
    // ✅ Индекс для поиска по городу
    await users.createIndex({ 'location.city': 1 });
    console.log('✅ Index: location.city');
    
    // ✅ Составной индекс для активных пользователей с временами намазов
    await users.createIndex({ 
      paymentStatus: 1, 
      'prayerTimes.fajr': 1 
    });
    console.log('✅ Composite Index: paymentStatus + prayerTimes.fajr');
    
    // ✅ Индекс для поиска неактивных пользователей
    await users.createIndex({ lastActiveDate: 1 });
    console.log('✅ Index: lastActiveDate');

    await users.createIndex({ subscriptionExpiresAt: 1 });
    console.log('✅ Index: subscriptionExpiresAt');

    // ✅ Составные индексы для лидербордов
    await users.createIndex({ paymentStatus: 1, xp: -1 });
    console.log('✅ Composite Index: paymentStatus + xp');

    await users.createIndex({ referredBy: 1, paymentStatus: 1, xp: -1 });
    console.log('✅ Composite Index: referredBy + paymentStatus + xp');

    await users.createIndex({ onboardingCompleted: 1, 'location.country': 1, xp: -1 });
    console.log('✅ Composite Index: onboardingCompleted + location.country + xp');

    await users.createIndex({ onboardingCompleted: 1, 'location.country': 1, 'location.city': 1, xp: -1 });
    console.log('✅ Composite Index: onboardingCompleted + location.country + location.city + xp');

    console.log('🎉 Все индексы успешно созданы!');
  } catch (error) {
    console.error('❌ Ошибка создания индексов:', error);
  }
}


export async function closeDB() {
  if (client) {
    await client.close();
    console.log('MongoDB соединение закрыто');
  }
}

process.on('SIGINT', async () => {
  await closeDB();
  process.exit(0);
});
