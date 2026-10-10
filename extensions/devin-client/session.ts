import { FileStore, type Grant, defaultStorePath } from './store.js';
import { oauth, oauthCode, type OAuthOptions } from './oauth.js';
import { check, deadline, expiry, fail, toDevinSessionToken } from './safety.js';

export type LoginMode = 'code' | 'loopback';

export type SessionState = 'missing' | 'expired' | 'revoked' | 'ok';

/** Login status safe to show in the UI. Never includes the session token. */
export interface SessionView {
  state: SessionState;
  expiresAt?: string;
  expirySource?: 'jwt' | 'fallback';
}

export interface SessionOptions extends OAuthOptions {
  storePath?: string;
}

/**
 * Standalone session owner: file-backed grant store + OAuth login.
 * Replaces the original DSH credentials / authorization integration.
 */
export class Sessions {
  private snapshot?: Grant;
  private searches = new AbortController();
  private disposed = false;
  readonly store: FileStore;

  constructor(private readonly options: SessionOptions = {}) {
    this.store = new FileStore(options.storePath ?? defaultStorePath());
  }

  async reload(): Promise<void> {
    this.snapshot = await this.store.read();
  }

  available(): boolean {
    return !this.disposed && !!this.snapshot && !this.snapshot.revoked && this.snapshot.expiresAt > Date.now();
  }

  async access(signal?: AbortSignal): Promise<{ token: string; signal: AbortSignal }> {
    if (signal?.aborted) check(signal);
    await this.reload();
    if (!this.available() || !this.snapshot) {
      return fail('login', 'Devin session missing, expired or revoked; run: devin-search auth');
    }
    return {
      token: toDevinSessionToken(this.snapshot.token),
      signal: deadline(AbortSignal.any([this.searches.signal, ...(signal ? [signal] : [])]), 90_000),
    };
  }

  async revoke(token: string): Promise<void> {
    const target = toDevinSessionToken(token);
    await this.reload();
    if (!this.snapshot) return;
    if (toDevinSessionToken(this.snapshot.token) !== target) return;
    const next: Grant = { ...this.snapshot, revoked: true };
    await this.store.write(next);
    this.searches.abort();
    this.searches = new AbortController();
    await this.reload();
  }

  invalidate(): void {
    this.snapshot = undefined;
    this.searches.abort();
    this.searches = new AbortController();
  }

  /** Loopback browser callback (same machine) or paste-code remote-safe PKCE. */
  async login(
    signal: AbortSignal,
    mode: LoginMode,
    notify: (url: string) => void,
    prompt?: (signal: AbortSignal) => Promise<string>,
  ): Promise<string> {
    check(signal);
    await this.reload();
    if (this.available() && this.snapshot) {
      return `Already logged in. Expires ${new Date(this.snapshot.expiresAt).toISOString()} (${this.snapshot.expirySource}; no automatic refresh).`;
    }
    const token =
      mode === 'code'
        ? await oauthCode(
            signal,
            notify,
            prompt ?? (() => fail('login', 'Code login requires a prompt callback.')),
            this.options,
          )
        : await oauth(signal, notify, this.options);
    check(signal);
    const sessionToken = toDevinSessionToken(token);
    const grant: Grant = { version: 1, token: sessionToken, ...expiry(sessionToken) };
    await this.store.write(grant);
    await this.reload();
    return `Login saved. Expires ${new Date(grant.expiresAt).toISOString()} (${grant.expirySource}; no automatic refresh).\nStored at: ${this.store.path}`;
  }

  async logout(): Promise<string> {
    this.invalidate();
    await this.store.clear();
    return `Logged out; cleared ${this.store.path}`;
  }

  async view(): Promise<SessionView> {
    await this.reload();
    if (!this.snapshot) return { state: 'missing' };
    const expiresAt = new Date(this.snapshot.expiresAt).toISOString();
    const expirySource = this.snapshot.expirySource;
    if (this.snapshot.revoked) return { state: 'revoked', expiresAt, expirySource };
    if (!this.available()) return { state: 'expired', expiresAt, expirySource };
    return { state: 'ok', expiresAt, expirySource };
  }

  async status(): Promise<string> {
    await this.reload();
    if (!this.snapshot) return `Not logged in. Store: ${this.store.path}`;
    if (this.snapshot.revoked) return `Session rejected by provider; run: devin-search auth\nStore: ${this.store.path}`;
    return `${this.available() ? 'Logged in' : 'Session expired; run: devin-search auth'}. Expires ${new Date(this.snapshot.expiresAt).toISOString()} (${this.snapshot.expirySource}; no automatic refresh).\nStore: ${this.store.path}`;
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }
}
