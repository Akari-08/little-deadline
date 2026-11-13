/**
 * Host-side Canvas LMS credentials, shared by the CLI and the host process.
 * Each user's own personal access token (see src/canvas/auth.ts for the parked OAuth option).
 * Returns null when no token is saved yet (provider = unconfigured).
 */
import type { AppStorage } from '../host/storage.ts';
import type { CanvasAuth } from './auth.ts';
import { PersonalTokenAuth } from './personal-token.ts';

export function createCanvasAuth(storage: AppStorage): CanvasAuth | null {
  return storage.loadCanvasPersonalToken()
    ? new PersonalTokenAuth({ loadToken: () => storage.loadCanvasPersonalToken() })
    : null;
}
