// db.js
import { MongoClient } from 'mongodb';

// Поддержка Railway MongoDB (MONGO_URL) и MongoDB Atlas (MONGODB_URI)
const connectionString = process.env.MONGO_URL || process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'imantap_db';

if (!connectionString) {
  throw new Error('MONGO_URL или MONGODB_URI должна быть установлена в переменных окружения');
}

const client = new MongoClient(connectionString, {
  serverSelectionTimeoutMS: 5000,
  maxPoolSize: 10,
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