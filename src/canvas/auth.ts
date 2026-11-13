/**
 * Canvas LMS authentication contract (Canvas LMS = coursework, not the Canvas 2D surface).
 *
 * Current implementation: PersonalTokenAuth (src/canvas/personal-token.ts) — each user creates
 * their own access token in Canvas (Account > Settings > Approved Integrations) and pastes it
 * into their own local copy of TaskPet.
 *
 * Parked: "Sign in with Canvas" (OAuth2 + PKCE). Instructure's API policy requires OAuth for
 * apps used by many people, and it needs a developer key issued by the institution. The full
 * mock-tested implementation lives in git history at commit f64a89c (src/canvas/oauth/,
 * scripts/canvas-login.ts, docs/canvas-oauth-setup.md) and can be restored with:
 *   git checkout f64a89c -- src/canvas/oauth test/canvas-oauth.test.ts test/helpers/mock-canvas-oauth.ts scripts/canvas-login.ts docs/canvas-oauth-setup.md
 *
 * Tokens are host-side only: never sent to UI code, the ESP32, logs, URLs or the repo, and
 * only ever transmitted to the configured Canvas origin over HTTPS as a Bearer header.
 */

/** 'oauth2' is reserved for the parked OAuth sign-in (see above). */
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
