import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { verifyTelegramInitData } from '../utils/telegramAuth.js';

const BOT_TOKEN = '123456:telegram-test-token';

function createInitData(values) {
  const params = new URLSearchParams(values);
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return params.toString();
}

test('accepts valid Telegram initData', () => {
  const initData = createInitData({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAEAAAE',
    user: JSON.stringify({ id: 12345, first_name: 'Iman' }),
  });

  assert.deepEqual(verifyTelegramInitData(initData, BOT_TOKEN)?.userId, 12345);
});

test('rejects tampered Telegram initData', () => {
  const initData = createInitData({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 12345 }),
  }).replace('12345', '99999');

  assert.equal(verifyTelegramInitData(initData, BOT_TOKEN), null);
});

test('rejects expired Telegram initData', () => {
  const initData = createInitData({
    auth_date: '1',
    user: JSON.stringify({ id: 12345 }),
  });

  assert.equal(verifyTelegramInitData(initData, BOT_TOKEN), null);
});
