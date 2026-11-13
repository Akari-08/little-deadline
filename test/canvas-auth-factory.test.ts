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

test('oauth2 mode: null until signed in and configured; never falls back to the personal token', withStorage(async storage => {
  storage.updateSettings(s => { s.canvas.baseUrl = 'https://canvas.example.edu'; s.canvas.authMode = 'oauth2'; s.canvas.oauthClientId = '10000000000001'; });
  storage.saveCanvasPersonalToken('canvas-test-token-0000');
  assert.equal(createCanvasAuth(storage), null, 'not signed in');
  storage.saveCanvasOAuthTokens({ accessToken: 'oauth-access-test', refreshToken: 'oauth-refresh-test', expiresAt: '2099-01-01T00:00:00Z', userId: '1' });
  const auth = createCanvasAuth(storage);
  assert.equal(auth?.kind, 'oauth2');
  assert.equal(await auth!.accessToken(), 'oauth-access-test');
}));

test('redirect port setting is validated', withStorage(storage => {
  assert.equal(storage.loadSettings().canvas.oauthRedirectPort, 51735);
  assert.equal(storage.updateSettings(s => { s.canvas.oauthRedirectPort = 80; }).canvas.oauthRedirectPort, 51735, 'privileged port rejected');
  assert.equal(storage.updateSettings(s => { s.canvas.oauthRedirectPort = 52000; }).canvas.oauthRedirectPort, 52000);
}));
