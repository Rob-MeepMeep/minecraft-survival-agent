'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Save and restore env vars around each test.
function withEnv(overrides, fn) {
  return () => {
    const saved = {};
    for (const key of Object.keys(overrides)) {
      saved[key] = process.env[key];
      if (overrides[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = overrides[key];
      }
    }
    try {
      return fn();
    } finally {
      for (const key of Object.keys(saved)) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  };
}

// Re-require config fresh each time to avoid module caching issues.
function loadConfigFresh() {
  // Clear the module cache for config.js.
  const configPath = require.resolve('../src/config');
  delete require.cache[configPath];
  return require(configPath).loadConfig();
}

test('valid config loads without error', withEnv({
  MC_HOST: 'localhost',
  MC_PORT: '25565',
  MC_USERNAME: 'TestBot',
  MC_AUTH: 'offline',
  MC_VERSION: '',
}, () => {
  const config = loadConfigFresh();
  assert.equal(config.host, 'localhost');
  assert.equal(config.port, 25565);
  assert.equal(config.username, 'TestBot');
  assert.equal(config.auth, 'offline');
  assert.equal(config.version, false);
}));

test('invalid port — non-numeric', withEnv({
  MC_PORT: 'abc',
  MC_AUTH: 'offline',
}, () => {
  assert.throws(() => loadConfigFresh(), (err) => {
    assert.match(err.message, /MC_PORT="abc"/);
    assert.match(err.message, /not a valid port/);
    return true;
  });
}));

test('invalid port — out of range', withEnv({
  MC_PORT: '99999',
  MC_AUTH: 'offline',
}, () => {
  assert.throws(() => loadConfigFresh(), (err) => {
    assert.match(err.message, /MC_PORT="99999"/);
    return true;
  });
}));

test('invalid port — zero', withEnv({
  MC_PORT: '0',
  MC_AUTH: 'offline',
}, () => {
  assert.throws(() => loadConfigFresh(), (err) => {
    assert.match(err.message, /MC_PORT="0"/);
    return true;
  });
}));

test('invalid port — negative', withEnv({
  MC_PORT: '-1',
  MC_AUTH: 'offline',
}, () => {
  assert.throws(() => loadConfigFresh(), (err) => {
    assert.match(err.message, /MC_PORT="-1"/);
    return true;
  });
}));

test('invalid port — decimal', withEnv({
  MC_PORT: '80.5',
  MC_AUTH: 'offline',
}, () => {
  assert.throws(() => loadConfigFresh(), (err) => {
    assert.match(err.message, /MC_PORT="80.5"/);
    return true;
  });
}));

test('invalid auth value', withEnv({
  MC_AUTH: 'badvalue',
  MC_PORT: '25565',
}, () => {
  assert.throws(() => loadConfigFresh(), (err) => {
    assert.match(err.message, /MC_AUTH="badvalue"/);
    assert.match(err.message, /Use "microsoft" or "offline"/);
    return true;
  });
}));

test('multiple errors reported together', withEnv({
  MC_PORT: 'abc',
  MC_AUTH: 'badvalue',
}, () => {
  assert.throws(() => loadConfigFresh(), (err) => {
    assert.match(err.message, /MC_PORT="abc"/);
    assert.match(err.message, /MC_AUTH="badvalue"/);
    assert.match(err.message, /\.env\.example/);
    return true;
  });
}));

test('microsoft auth accepted', withEnv({
  MC_AUTH: 'microsoft',
  MC_PORT: '25565',
}, () => {
  const config = loadConfigFresh();
  assert.equal(config.auth, 'microsoft');
}));

test('auto-detect version when empty', withEnv({
  MC_VERSION: '',
  MC_AUTH: 'offline',
  MC_PORT: '25565',
}, () => {
  const config = loadConfigFresh();
  assert.equal(config.version, false);
}));

test('explicit version passed through', withEnv({
  MC_VERSION: '1.21.5',
  MC_AUTH: 'offline',
  MC_PORT: '25565',
}, () => {
  const config = loadConfigFresh();
  assert.equal(config.version, '1.21.5');
}));

test('defaults applied when env vars absent', withEnv({
  MC_HOST: undefined,
  MC_PORT: undefined,
  MC_USERNAME: undefined,
  MC_AUTH: undefined,
  MC_VERSION: undefined,
}, () => {
  const config = loadConfigFresh();
  assert.equal(config.host, 'localhost');
  assert.equal(config.port, 25565);
  assert.equal(config.username, 'SurvivalAgent');
  assert.equal(config.auth, 'microsoft');
  assert.equal(config.version, false);
}));
