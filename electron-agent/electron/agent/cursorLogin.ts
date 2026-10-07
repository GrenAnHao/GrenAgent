import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveCursorAccessToken } from '../../../cli/src/cursor/oauth.js';
import { loginCursor } from '../../../cli/src/cursor/vendor/registry/oauth/cursor.js';

export interface StartCursorLoginOptions {
  agentDir: string;
  openLoginUrl: (url: string) => void | Promise<void>;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export async function startCursorLogin(options: StartCursorLoginOptions): Promise<void> {
  const restoreFetch = installFetch(options.fetch);
  const opened = Promise.withResolvers<void>();
  let openStarted = false;
  try {
    const credentials = await loginCursor((url) => {
      openStarted = true;
      opened.resolve(Promise.resolve(options.openLoginUrl(url)));
    });
    await opened.promise;
    await mkdir(options.agentDir, { recursive: true });
    await rm(join(options.agentDir, 'cursor-credentials.json'), { force: true });
    await resolveCursorAccessToken(options.agentDir, {
      login: async () => credentials,
      fetch: async () => {
        throw new Error('Cursor 登录失败');
      },
    });
  } catch (error) {
    if (openStarted) void opened.promise.catch(() => {});
    throw publicLoginError(error);
  } finally {
    restoreFetch();
  }
}

function installFetch(fetchImpl: StartCursorLoginOptions['fetch']): () => void {
  if (!fetchImpl) return () => {};
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

function publicLoginError(error: unknown): Error {
  if (!(error instanceof Error) || mentionsCredential(error.message)) return new Error('Cursor 登录失败');
  return error;
}

function mentionsCredential(message: string): boolean {
  return /bearer\s+\S+/i.test(message)
    || /accessToken|refreshToken|refresh-secret/i.test(message)
    || /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(message);
}
