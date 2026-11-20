import crypto from 'crypto';

/**
 * Verifies the signed initData string supplied by Telegram Mini Apps.
 * Never trust initDataUnsafe or a userId received from the browser directly.
 */
export function verifyTelegramInitData(initData, botToken, maxAgeSeconds = 24 * 60 * 60) {
  if (typeof initData !== 'string' || !initData || !botToken) return null;

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    const authDate = Number(params.get('auth_date'));
    const userJson = params.get('user');

    if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) return null;
    if (!Number.isFinite(authDate) || authDate <= 0 || !userJson) return null;
    if (Date.now() / 1000 - authDate > maxAgeSeconds) return null;

    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();
    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    const received = Buffer.from(receivedHash, 'hex');
    const calculated = Buffer.from(calculatedHash, 'hex');
    if (received.length !== calculated.length || !crypto.timingSafeEqual(received, calculated)) {
      return null;
    }

    const user = JSON.parse(userJson);
    const userId = Number(user.id);
    return Number.isSafeInteger(userId) && userId > 0 ? { userId, user } : null;
  } catch {
    return null;
  }
}
