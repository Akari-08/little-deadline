/**
 * Host-side choice of Canvas LMS credentials, shared by the CLI and the host process.
 *   personal-token: the user's own access token (single-user use only, per Canvas API Policy)
 *   oauth2:         "Sign in with Canvas" via the institution's developer key
 * Returns null when the selected method has no usable credentials yet (provider = unconfigured).
 */
import type { AppStorage } from '../host/storage.ts';
import type { CanvasAuth } from './auth.ts';
import { PersonalTokenAuth } from './personal-token.ts';
import { loadOAuthConfig } from './oauth/config.ts';
import { OAuth2CanvasAuth } from './oauth/oauth-auth.ts';
import { appStorageTokenStore } from './oauth/token-store.ts';

export function createCanvasAuth(storage: AppStorage): CanvasAuth | null {
  const settings = storage.loadSettings().canvas;
  if (settings.authMode === 'personal-token') {
    return storage.loadCanvasPersonalToken()
      ? new PersonalTokenAuth({ loadToken: () => storage.loadCanvasPersonalToken() })
      : null;
  }
  if (!storage.describeSecrets().canvasSignedIn) return null;
  // Refresh must send the same redirect_uri (port) that sign-in used.
  const resolved = loadOAuthConfig(storage, { redirectPort: settings.oauthRedirectPort });
  if (!resolved.ok) return null;
  return new OAuth2CanvasAuth({ config: resolved.config, store: appStorageTokenStore(storage) });
}
