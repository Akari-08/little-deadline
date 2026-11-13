import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStorage } from '../src/host/storage.ts';
import { createCanvasAuth } from '../src/canvas/create-auth.ts';

function withStorage(fn: (storage: AppStorage) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'taskpet-auth-'));
    try { await fn(new AppStorage(dir)); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

test('personal-token mode: null until a token is saved, then a personal-token auth', withStorage(async storage => {
  storage.updateSettings(s => { s.canvas.baseUrl = 'https://canvas.example.edu'; });
  assert.equal(createCanvasAuth(storage), null);
  storage.saveCanvasPersonalToken('canvas-test-token-0000');
  const auth = createCanvasAuth(storage);
  assert.equal(auth?.kind, 'personal-token');
  assert.equal(await auth!.accessToken(), 'canvas-test-token-0000');
}));

test('legacy OAuth settings/secrets from older files are ignored and dropped', withStorage(async storage => {
  storage.saveSettings({ ...storage.loadSettings(), canvas: { ...storage.loadSettings().canvas, baseUrl: 'https://canvas.example.edu', authMode: 'oauth2', oauthClientId: 'x' } } as never);
  assert.ok(!('authMode' in storage.loadSettings().canvas));
  storage.saveCanvasPersonalToken('canvas-test-token-0000');
  assert.equal(createCanvasAuth(storage)?.kind, 'personal-token');
}));
