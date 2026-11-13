/**
 * Device token rules (same as the connector and firmware): 32–128 printable ASCII
 * characters, no spaces. Messages never include any part of the token itself.
 */
export const TOKEN_MIN_LENGTH = 32;
export const TOKEN_MAX_LENGTH = 128;

/** Returns a user-facing problem description, or null when the token is acceptable. */
export function checkDeviceToken(token: string): string | null {
  if (token.length < TOKEN_MIN_LENGTH || token.length > TOKEN_MAX_LENGTH) {
    return `The device token must be ${TOKEN_MIN_LENGTH}–${TOKEN_MAX_LENGTH} characters (this one has ${token.length})`;
  }
  if (!/^[\x21-\x7e]+$/.test(token)) return 'The device token must be printable ASCII with no spaces';
  return null;
}

/** Remove any accidental occurrence of the token from text before it is shown or logged. */
export function redactToken(text: string, token: string | null): string {
  if (!token) return text;
  return text.split(token).join('[device token]');
}
