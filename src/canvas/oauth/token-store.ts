/**
 * Where the signed-in user's Canvas OAuth tokens live. The default adapter writes to the
 * per-user secrets file through AppStorage (host process only, outside the repository).
 */
import type { CanvasOAuthTokens } from '../../host/storage.ts';

export type { CanvasOAuthTokens };

export interface CanvasOAuthTokenStore {
  load(): CanvasOAuthTokens | null;
  /** Save new tokens, or clear them with null. */
  save(tokens: CanvasOAuthTokens | null): void;
}

export interface OAuthTokenPersistence {
  loadCanvasOAuthTokens(): CanvasOAuthTokens | null;
  saveCanvasOAuthTokens(tokens: CanvasOAuthTokens | null): void;
}

/** Adapter for AppStorage (or anything with the same two methods). */
export function appStorageTokenStore(storage: OAuthTokenPersistence): CanvasOAuthTokenStore {
  return {
    load: () => storage.loadCanvasOAuthTokens(),
    save: tokens => storage.saveCanvasOAuthTokens(tokens),
  };
}

/** In-memory store for tests and hardware-free preview mode. */
export class MemoryTokenStore implements CanvasOAuthTokenStore {
  private tokens: CanvasOAuthTokens | null;
  saves = 0;

  constructor(initial: CanvasOAuthTokens | null = null) {
    this.tokens = initial ? { ...initial } : null;
  }

  load(): CanvasOAuthTokens | null {
    return this.tokens ? { ...this.tokens } : null;
  }

  save(tokens: CanvasOAuthTokens | null): void {
    this.saves++;
    this.tokens = tokens ? { ...tokens } : null;
  }
}
