/**
 * Canvas LMS authentication contract (Canvas LMS = coursework, not the Canvas 2D surface).
 *
 * Two implementations:
 *  - PersonalTokenAuth (src/canvas/personal-token.ts): a token the user generated for their
 *    OWN use in Canvas (Account > Settings > Approved Integrations). Single user only.
 *  - OAuth2 (src/canvas/oauth/): "Sign in with Canvas" through the institution's normal login
 *    page, using a developer key issued by the institution. Required for multi-user apps by
 *    the Canvas API Policy. TaskPet never sees or stores the user's school password.
 *
 * Tokens are host-side only: never sent to UI code, the ESP32, logs, URLs or the repo, and
 * only ever transmitted to the configured Canvas origin over HTTPS as a Bearer header.
 */

export type CanvasAuthKind = 'personal-token' | 'oauth2';

export interface CanvasAuth {
  readonly kind: CanvasAuthKind;
  /**
   * A currently valid access token, refreshing first if it is (nearly) expired.
   * Throws ProviderAuthError (src/tasks/types.ts) when the user is not signed in or the
   * credentials can no longer be refreshed.
   */
  accessToken(signal?: AbortSignal): Promise<string>;
  /**
   * Called after Canvas answers 401. Return true if a different, fresh token is now available
   * (e.g. an OAuth refresh succeeded) so the request may be retried once; false otherwise.
   */
  handleUnauthorized(signal?: AbortSignal): Promise<boolean>;
}
