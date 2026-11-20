import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BOT_USERNAME, getBotUsername, getMiniAppDeepLink } from '../config.js';

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

test('getBotUsername falls back to default and strips leading @', () => {
  withEnv({ BOT_USERNAME: undefined }, () => {
    assert.equal(getBotUsername(), DEFAULT_BOT_USERNAME);
  });

  withEnv({ BOT_USERNAME: '   ' }, () => {
    assert.equal(getBotUsername(), DEFAULT_BOT_USERNAME);
  });

  withEnv({ BOT_USERNAME: '@custom_bot ' }, () => {
    assert.equal(getBotUsername(), 'custom_bot');
  });
});

test('getMiniAppDeepLink never emits undefined in URL', () => {
  withEnv({ BOT_USERNAME: undefined, MINI_APP_NAME: undefined }, () => {
    const link = getMiniAppDeepLink();
    assert.equal(link, `https://t.me/${DEFAULT_BOT_USERNAME}`);
    assert.ok(!link.includes('undefined'));
  });

  withEnv({ BOT_USERNAME: 'my_bot', MINI_APP_NAME: '  ' }, () => {
    assert.equal(getMiniAppDeepLink(), 'https://t.me/my_bot');
  });

  withEnv({ BOT_USERNAME: '@my_bot', MINI_APP_NAME: '/app/' }, () => {
    assert.equal(getMiniAppDeepLink(), 'https://t.me/my_bot/app');
  });
});
