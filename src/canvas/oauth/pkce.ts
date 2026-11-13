/**
 * Random values for the OAuth2 authorization code flow: `state` (CSRF protection) and the
 * PKCE (RFC 7636) S256 verifier/challenge pair. None of these values may be logged.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A URL-safe random string with `bytes` bytes of entropy (base64url, no padding). */
export function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export interface PkcePair {
  /** Secret kept in the host process until the code exchange (43–128 chars per RFC 7636). */
  verifier: string;
  /** BASE64URL(SHA256(verifier)), sent in the authorize URL. */
  challenge: string;
  method: 'S256';
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function createPkcePair(): PkcePair {
  const verifier = randomUrlSafe(32); // 43 characters
  return { verifier, challenge: pkceChallenge(verifier), method: 'S256' };
}

/**
 * Constant-time string comparison. Both inputs are hashed first so differing lengths do not
 * short-circuit (and timingSafeEqual never throws on a length mismatch).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
