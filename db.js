// db.js
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

// Валидация переменных окружения
if (!process.env.MONGODB_URI) {
  throw new Error('❌ MONGODB_URI не указан в .env файле');
}

if (!process.env.DB_NAME) {
  throw new Error('❌ DB_NAME не указан в .env файле');
}

// Создание клиента MongoDB
const client = new MongoClient(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 5000, // Timeout 5 секунд
  maxPoolSize: 10, // Максимум 10 соединений
});

let db = null;
let isConnected = false;

/**
 * Подключение к MongoDB
 */
async function connectDB() {
  if (isConnected && db) {
    console.log('✅ MongoDB уже подключена');
    return db;
  }

  try {
    console.log('🔄 Подключение к MongoDB...');
    await client.connect();
    
    // Проверка подключения
    await client.db('admin').command({ ping: 1 });
    
    db = client.db(process.env.DB_NAME);
    isConnected = true;
    
    console.log('✅ MongoDB успешно подключена');
    console.log(`📦 База данных: ${process.env.DB_NAME}`);
    
    return db;
  } catch (error) {
    console.error('❌ Ошибка подключения к MongoDB:', error.message);
    isConnected = false;
    throw error;
  }
}

/**
 * Получить базу данных
 */
function getDB() {
  if (!isConnected || !db) {
    throw new Error('❌ База данных не подключена. Вызовите connectDB() сначала.');
  }
  return db;
}

/**
 * Закрыть соединение (для graceful shutdown)
 */
async function closeDB() {
  if (client && isConnected) {
    console.log('🔄 Закрытие соединения с MongoDB...');
    await client.close();
    isConnected = false;
    db = null;
    console.log('✅ MongoDB отключена');
  }
}

// Обработка завершения процесса
process.on('SIGINT', async () => {
  await closeDB();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeDB();
  process.exit(0);
});

export { connectDB, getDB, closeDB };
