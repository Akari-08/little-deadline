/**
 * Canvas LMS personal access token auth: a token the user generated for their OWN use in Canvas
 * (Account > Settings > Approved Integrations > New Access Token). Each user supplies their own
 * token to their own local copy of TaskPet; it never leaves their machine except as a Bearer
 * header to their school's Canvas. Note: Instructure's API policy expects OAuth for apps used by
 * many people (parked; see src/canvas/auth.ts).
 *
 * The token is read from the host-side secret store on every request, so saving a new token
 * takes effect without restarting. It cannot be refreshed: a 401 means the user must create a
 * new one in Canvas.
 */
import type { CanvasAuth } from './auth.ts';
import { ProviderAuthError } from '../tasks/types.ts';

export interface PersonalTokenAuthOptions {
  /** Returns the saved token, or null when none is saved. */
  loadToken: () => string | null;
}

export const NO_PERSONAL_TOKEN_MESSAGE =
  'No Canvas access token is saved. Create one in Canvas (Account > Settings > Approved Integrations > New Access Token) and enter it in Lil Deadline Settings.';

export class PersonalTokenAuth implements CanvasAuth {
  readonly kind = 'personal-token' as const;
  private readonly loadToken: () => string | null;

  constructor(options: PersonalTokenAuthOptions) {
    this.loadToken = options.loadToken;
  }

  async accessToken(): Promise<string> {
    const token = this.loadToken()?.trim() ?? '';
    if (!token) throw new ProviderAuthError(NO_PERSONAL_TOKEN_MESSAGE);
    if (!/^[\x21-\x7e]+$/.test(token)) {
      throw new ProviderAuthError('The saved Canvas access token is not valid (it must be printable characters with no spaces). Enter it again in Settings.');
    }
    return token;
  }

  /** A personal token cannot be refreshed; the user has to create a new one. */
  async handleUnauthorized(): Promise<boolean> {
    return false;
  }
}
