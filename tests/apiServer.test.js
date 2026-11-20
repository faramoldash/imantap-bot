import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';

// db.js validates MONGO_URL on module load (does not connect until connectDB()).
process.env.MONGO_URL ??= 'mongodb://127.0.0.1:27017/imantap_test';

const { buildAllowedOrigins, createApiServer } = await import('../apiServer.js');

const BOT_TOKEN = '123456:telegram-test-token';

function createSignedInitData(userId) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAEAAAE',
    user: JSON.stringify({ id: userId, first_name: 'Iman' }),
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return params.toString();
}

function invokeServer(server, { method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    );

    const responseHeaders = new Map();
    let statusCode = 200;
    let rawBody = '';

    const res = {
      get statusCode() {
        return statusCode;
      },
      set statusCode(code) {
        statusCode = code;
      },
      setHeader(name, value) {
        responseHeaders.set(name.toLowerCase(), String(value));
      },
      getHeader(name) {
        return responseHeaders.get(name.toLowerCase());
      },
      writeHead(code, extraHeaders = {}) {
        statusCode = code;
        for (const [k, v] of Object.entries(extraHeaders)) {
          responseHeaders.set(k.toLowerCase(), String(v));
        }
      },
      end(chunk = '') {
        if (chunk) rawBody += String(chunk);
        resolve({
          status: statusCode,
          headers: {
            get(name) {
              return responseHeaders.get(name.toLowerCase()) ?? null;
            },
          },
          text: rawBody,
          json() {
            return JSON.parse(rawBody);
          },
        });
      },
    };

    try {
      server.emit('request', req, res);
      if (body) {
        req.emit('data', Buffer.from(body));
      }
      req.emit('end');
    } catch (err) {
      reject(err);
    }
  });
}

function createTestServer(options = {}) {
  return createApiServer({
    bot: { sendMessage: async () => {} },
    botToken: BOT_TOKEN,
    checkRateLimit: () => true,
    ...options,
  });
}

test('buildAllowedOrigins includes normalized MINI_APP_URL and dev localhost only outside production', () => {
  const devOrigins = buildAllowedOrigins({
    miniAppUrl: 'https://imantap-app.example.com/app/',
    nodeEnv: 'development',
    extraOrigins: '',
  });
  assert.equal(devOrigins.has('https://imantap-app.example.com'), true);
  assert.equal(devOrigins.has('http://localhost:3000'), true);
  assert.equal(devOrigins.has('https://web.telegram.org'), true);

  const prodOrigins = buildAllowedOrigins({
    miniAppUrl: 'https://imantap-app.example.com/app/',
    nodeEnv: 'production',
    extraOrigins: '',
  });
  assert.equal(prodOrigins.has('https://imantap-app.example.com'), true);
  assert.equal(prodOrigins.has('http://localhost:3000'), false);
  assert.equal(prodOrigins.has('http://localhost:5173'), false);
});

test('health endpoint is public and never combines wildcard CORS with credentials', async () => {
  const server = createTestServer({
    miniAppUrl: 'https://miniapp.imantap.kz',
    nodeEnv: 'production',
  });

  const res = await invokeServer(server, { method: 'GET', url: '/health' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
  assert.equal(res.json().status, 'ok');
});

test('CORS allows MINI_APP_URL and localhost:3000 in dev, blocks unknown/spoofed origins', async () => {
  const server = createTestServer({
    miniAppUrl: 'https://miniapp.imantap.kz/path',
    nodeEnv: 'development',
  });

  for (const allowedOrigin of ['https://miniapp.imantap.kz', 'http://localhost:3000', 'https://web.telegram.org']) {
    const res = await invokeServer(server, {
      method: 'OPTIONS',
      url: '/api/check-access?userId=123',
      headers: { Origin: allowedOrigin },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), allowedOrigin);
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(res.headers.get('vary'), 'Origin');
    assert.match(res.headers.get('access-control-allow-headers') || '', /X-Telegram-Init-Data/);
  }

  for (const blockedOrigin of [
    'https://evil.com',
    'https://evil-telegram.attacker.com',
    'https://fake-t.me.attacker.com',
    'https://attacker.up.railway.app',
  ]) {
    const preflight = await invokeServer(server, {
      method: 'OPTIONS',
      url: '/api/check-access?userId=123',
      headers: { Origin: blockedOrigin },
    });
    assert.equal(preflight.status, 403);
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null);

    const health = await invokeServer(server, {
      method: 'GET',
      url: '/health',
      headers: { Origin: blockedOrigin },
    });
    assert.equal(health.headers.get('access-control-allow-origin'), null);
    assert.equal(health.headers.get('access-control-allow-credentials'), null);
  }
});

test('CORS blocks localhost:3000 in production', async () => {
  const server = createTestServer({
    miniAppUrl: 'https://miniapp.imantap.kz',
    nodeEnv: 'production',
  });

  const res = await invokeServer(server, {
    method: 'OPTIONS',
    url: '/api/check-access?userId=123',
    headers: { Origin: 'http://localhost:3000' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('all protected API routes reject missing X-Telegram-Init-Data with 401', async () => {
  const server = createTestServer({
    miniAppUrl: 'https://miniapp.imantap.kz',
    nodeEnv: 'development',
  });

  const protectedRequests = [
    ['GET', '/api/check-access?userId=123'],
    ['GET', '/api/user/123/access'],
    ['POST', '/api/user/123/sync'],
    ['GET', '/api/user?userId=123'],
    ['GET', '/api/user/123/full'],
    ['GET', '/api/leaderboard/friends/123'],
    ['GET', '/api/leaderboard/countries'],
    ['GET', '/api/leaderboard/cities'],
    ['GET', '/api/leaderboard/global'],
    ['GET', '/api/contest/current?userId=123'],
    ['GET', '/api/contest/507f1f77bcf86cd799439011/leaderboard'],
    ['POST', '/api/circles/create'],
    ['GET', '/api/circles/user/123'],
    ['GET', '/api/circles/c1/details?userId=123'],
    ['POST', '/api/circles/invite'],
    ['POST', '/api/circles/accept'],
    ['POST', '/api/circles/leave'],
    ['POST', '/api/circles/remove-member'],
    ['POST', '/api/circles/delete'],
    ['POST', '/api/circles/decline'],
    ['POST', '/api/circles/join'],
    ['POST', '/shawwal-fast'],
  ];

  for (const [method, url] of protectedRequests) {
    const res = await invokeServer(server, {
      method,
      url,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
      body: method === 'POST' ? '{}' : '',
    });
    assert.equal(res.status, 401, `Expected 401 for ${method} ${url}, got ${res.status}`);
  }
});

test('user-scoped routes reject accessing another userId with 403', async () => {
  const server = createTestServer({
    miniAppUrl: 'https://miniapp.imantap.kz',
    nodeEnv: 'development',
  });
  const initData = createSignedInitData(123);

  const crossUserRequests = [
    ['GET', '/api/check-access?userId=999'],
    ['GET', '/api/user/999/access'],
    ['POST', '/api/user/999/sync'],
    ['GET', '/api/user?userId=999'],
    ['GET', '/api/user/999/full'],
    ['GET', '/api/leaderboard/friends/999'],
    ['GET', '/api/contest/current?userId=999'],
    ['GET', '/api/circles/user/999'],
    ['GET', '/api/circles/c1/details?userId=999'],
  ];

  for (const [method, url] of crossUserRequests) {
    const res = await invokeServer(server, {
      method,
      url,
      headers: {
        'X-Telegram-Init-Data': initData,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: method === 'POST' ? '{}' : '',
    });
    assert.equal(res.status, 403, `Expected 403 for ${method} ${url}, got ${res.status}`);
  }
});
