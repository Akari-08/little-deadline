/**
 * Canvas LMS personal access token auth: a token the user generated for their OWN use in Canvas
 * (Account > Settings > Approved Integrations > New Access Token). Single user only; apps used
 * by many people must use OAuth2 instead (see src/canvas/auth.ts).
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
  'No Canvas access token is saved. Create one in Canvas (Account > Settings > Approved Integrations > New Access Token) and save it with: npm run configure -- canvas-token';

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
      throw new ProviderAuthError('The saved Canvas access token is not valid (it must be printable characters with no spaces). Save it again with: npm run configure -- canvas-token');
    }
    return token;
  }

  /** A personal token cannot be refreshed; the user has to create a new one. */
  async handleUnauthorized(): Promise<boolean> {
    return false;
  }
}
