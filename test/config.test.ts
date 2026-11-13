import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseDeviceAddress } from '../src/device/address.ts';
import { checkDeviceToken } from '../src/device/token.ts';
import { classifyLinkError } from '../src/device/errors.ts';
import { AppStorage, DEFAULT_SETTINGS, defaultDataDir } from '../src/host/storage.ts';
import { TEST_TOKEN } from './helpers/fakes.ts';

test('device addresses: IP, .local, full URL; default port 81', () => {
  const ok = (input: string) => {
    const result = parseDeviceAddress(input);
    assert.ok(result.ok, `${input}: ${!result.ok ? result.error : ''}`);
    return result.value;
  };
  assert.equal(ok('192.168.1.123').url, 'ws://192.168.1.123:81/');
  assert.equal(ok(' ws://192.168.1.123:81/ ').url, 'ws://192.168.1.123:81/');
  assert.equal(ok('ws://192.168.1.123').url, 'ws://192.168.1.123:81/');
  const mdns = ok('taskpet-a1b2c3.local');
  assert.equal(mdns.url, 'ws://taskpet-a1b2c3.local:81/');
  assert.equal(mdns.isMdns, true);
  assert.equal(ok('127.0.0.1:8181').port, 8181, 'explicit port kept (simulated device)');
  assert.equal(ok('127.0.0.1:8181').isLoopback, true);
  assert.equal(ok('localhost:8181').isLoopback, true);
  assert.equal(ok('192.168.1.123').isLoopback, false);
});

test('device addresses: rejects other schemes, paths, credentials and queries', () => {
  for (const bad of ['', 'wss://1.2.3.4/', 'http://1.2.3.4', 'ws://1.2.3.4:81/ws', 'ws://user:pw@1.2.3.4/', 'ws://1.2.3.4/?token=x', 'not a host', '999.1.1.1']) {
    assert.equal(parseDeviceAddress(bad).ok, false, bad);
  }
});

test('device token rules match the connector', () => {
  assert.equal(checkDeviceToken(TEST_TOKEN), null);
  assert.equal(checkDeviceToken('a'.repeat(32)), null);
  assert.equal(checkDeviceToken('a'.repeat(128)), null);
  assert.notEqual(checkDeviceToken('a'.repeat(31)), null);
  assert.notEqual(checkDeviceToken('a'.repeat(129)), null);
  assert.notEqual(checkDeviceToken(`${'a'.repeat(32)} b`), null);
  assert.ok(!checkDeviceToken(`${TEST_TOKEN} `)!.includes(TEST_TOKEN), 'messages never echo the token');
});

test('error classification', () => {
  const kind = (message: string) => classifyLinkError(new Error(message)).kind;
  assert.equal(kind('Device error: auth_failed'), 'auth');
  assert.equal(kind('Device error: busy'), 'busy');
  assert.equal(kind('Device error: strip_order'), 'protocol');
  assert.equal(kind('Device error: fragmented_message_unsupported'), 'protocol');
  assert.equal(kind('Incompatible display configuration'), 'config');
  assert.equal(kind('Connection/authentication timed out'), 'timeout');
  assert.equal(kind('Frame acknowledgement timed out'), 'timeout');
  assert.equal(kind('Device disconnected'), 'transport');
  assert.equal(kind('Invalid device JSON'), 'protocol');
});

function tempStorage() {
  const dir = mkdtempSync(join(tmpdir(), 'taskpet-test-'));
  return { dir, storage: new AppStorage(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('data dir defaults to the per-user app data folder, not the repo', () => {
  assert.equal(defaultDataDir({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'win32', 'C:\\Users\\x'), join('C:\\Users\\x\\AppData\\Roaming', 'TaskPet'));
  assert.equal(defaultDataDir({ TASKPET_DATA_DIR: '/tmp/tp' }, 'linux', '/home/x'), '/tmp/tp');
  assert.equal(defaultDataDir({}, 'linux', '/home/x'), join('/home/x', '.config', 'taskpet'));
});

test('settings: defaults, versioned round trip, sanitizing', () => {
  const { storage, cleanup } = tempStorage();
  try {
    assert.deepEqual(storage.loadSettings(), DEFAULT_SETTINGS);
    storage.updateSettings(s => { s.device.address = 'taskpet-a1b2c3.local'; s.streaming.targetFps = 999; });
    const loaded = storage.loadSettings();
    assert.equal(loaded.schemaVersion, 1);
    assert.equal(loaded.device.address, 'taskpet-a1b2c3.local');
    assert.equal(loaded.streaming.targetFps, 30, 'clamped');
  } finally { cleanup(); }
});

test('token is stored separately from settings and never in settings.json', () => {
  const { storage, cleanup } = tempStorage();
  try {
    storage.updateSettings(s => { s.device.address = '10.0.0.2'; });
    storage.saveDeviceToken(TEST_TOKEN);
    assert.equal(storage.loadDeviceToken(), TEST_TOKEN);
    assert.ok(!readFileSync(storage.settingsPath, 'utf8').includes(TEST_TOKEN));
    assert.equal(storage.describeSecrets().deviceTokenSet, true);
    assert.ok(!JSON.stringify(storage.describeSecrets()).includes(TEST_TOKEN));
    assert.throws(() => storage.saveDeviceToken('too short'), (e: Error) => !e.message.includes('too short'));
    storage.saveDeviceToken(null);
    assert.equal(storage.loadDeviceToken(), null);
  } finally { cleanup(); }
});

test('corrupt settings are set aside and defaults used', () => {
  const { dir, storage, cleanup } = tempStorage();
  try {
    writeFileSync(storage.settingsPath, '{ not json');
    assert.deepEqual(storage.loadSettings(), DEFAULT_SETTINGS);
    assert.ok(readdirSync(dir).some(name => name.startsWith('settings.json.corrupt-')));
    assert.equal(storage.warnings.length, 1);
  } finally { cleanup(); }
});

test('vendored connector files match the supplied package across Git checkout line endings', () => {
  const hash = (path: string) => createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
  for (const name of ['taskpet-link.mjs', 'taskpet-link.test.mjs', 'loopback-test.mjs', 'smoke-test.mjs']) {
    assert.equal(hash(join('device-link', name)), hash(join('TaskPetLink', 'client', name)), name);
  }
  assert.equal(hash(join('device-link', 'PROTOCOL.txt')), hash(join('TaskPetLink', 'PROTOCOL.txt')));
});

test('corrupt secrets are removed (no token copy kept) and stale temp files are cleaned', () => {
  const { dir, storage, cleanup } = tempStorage();
  try {
    storage.saveDeviceToken(TEST_TOKEN);
    writeFileSync(storage.secretsPath, `{"deviceToken":"${TEST_TOKEN}`); // truncated JSON
    writeFileSync(`${storage.secretsPath}.tmp-999`, TEST_TOKEN);
    assert.equal(storage.loadDeviceToken(), null);
    const leftovers = readdirSync(dir).filter(name => name.startsWith('secrets.json'));
    assert.deepEqual(leftovers, [], 'no corrupt or temp copy of the token remains');
  } finally { cleanup(); }
});

test('settings from a newer schema keep known fields and warn', () => {
  const { storage, cleanup } = tempStorage();
  try {
    writeFileSync(storage.settingsPath, JSON.stringify({ schemaVersion: 99, device: { address: '10.0.0.9', autoConnect: true }, future: 1 }));
    const settings = storage.loadSettings();
    assert.equal(settings.device.address, '10.0.0.9');
    assert.equal(settings.device.autoConnect, true);
    assert.match(storage.warnings.join(' '), /newer TaskPet/);
  } finally { cleanup(); }
});

test('Canvas secrets are stored beside the device token without clobbering it', () => {
  const { storage, cleanup } = tempStorage();
  try {
    storage.saveDeviceToken(TEST_TOKEN);
    storage.saveCanvasPersonalToken('canvas-test-token-0000');
    storage.updateSettings(s => { s.canvas.baseUrl = 'https://canvas.example.edu'; });
    assert.equal(storage.loadDeviceToken(), TEST_TOKEN);
    assert.equal(storage.loadCanvasPersonalToken(), 'canvas-test-token-0000');
    assert.deepEqual(storage.describeSecrets(), { deviceTokenSet: true, canvasPersonalTokenSet: true });
    const settingsText = readFileSync(storage.settingsPath, 'utf8');
    for (const secret of [TEST_TOKEN, 'canvas-test-token-0000']) {
      assert.ok(!settingsText.includes(secret), 'no secret in settings.json');
      assert.ok(!JSON.stringify(storage.describeSecrets()).includes(secret));
    }
    storage.saveDeviceToken(null);
    assert.equal(storage.loadCanvasPersonalToken(), 'canvas-test-token-0000', 'clearing one secret keeps the others');
    assert.throws(() => storage.saveCanvasPersonalToken('has space token'), /printable/);
  } finally { cleanup(); }
});

test('Canvas settings defaults and clamping', () => {
  const { storage, cleanup } = tempStorage();
  try {
    assert.deepEqual(storage.loadSettings().canvas, { baseUrl: '', lookbackDays: 7, lookaheadDays: 21, refreshMinutes: 15 });
    const saved = storage.updateSettings(s => { s.canvas.lookaheadDays = 9999; s.canvas.refreshMinutes = 1; });
    assert.equal(saved.canvas.lookaheadDays, 120);
    assert.equal(saved.canvas.refreshMinutes, 5);
  } finally { cleanup(); }
});
