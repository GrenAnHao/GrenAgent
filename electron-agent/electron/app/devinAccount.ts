import { Sessions, type SessionView } from '../../../extensions/devin-client/session.js';
import type { DevinOAuthWindow } from './devinOAuthWindow.js';

export const DEVIN_OAUTH_SUCCESS = '授权完成。可以关闭此窗口，回到设置。';

export interface DevinSessionPort {
  view(): Promise<SessionView>;
  login(signal: AbortSignal, notify: (url: string) => void): Promise<string>;
  logout(): Promise<string>;
  dispose(): void;
}

export type DevinOAuthOpener = (url: string) => DevinOAuthWindow;

const LOGIN_MS = 5 * 60_000;

export function createDevinAccount(openSession: () => DevinSessionPort, timeoutMs = LOGIN_MS) {
  let inflight: Promise<SessionView> | null = null;

  return {
    async status(): Promise<SessionView> {
      const sessions = openSession();
      try {
        return await sessions.view();
      } finally {
        sessions.dispose();
      }
    },

    login(openAuthorize: DevinOAuthOpener): Promise<SessionView> {
      if (inflight) return inflight;
      inflight = (async () => {
        const sessions = openSession();
        const controller = new AbortController();
        let cause: 'timeout' | 'closed' = 'closed';
        let programmatic = false;
        let oauthWindow: DevinOAuthWindow | undefined;
        const timer = setTimeout(() => {
          cause = 'timeout';
          controller.abort();
        }, timeoutMs);
        try {
          await sessions.login(controller.signal, (url) => {
            oauthWindow = openAuthorize(url);
            oauthWindow.onClosed(() => {
              if (!programmatic && !controller.signal.aborted) {
                cause = 'closed';
                controller.abort();
              }
            });
          });
          programmatic = true;
          oauthWindow?.close();
          return await sessions.view();
        } catch (error) {
          programmatic = true;
          oauthWindow?.close();
          if (controller.signal.aborted) {
            throw new Error(cause === 'timeout' ? '登录超时，请重试。' : '登录已取消。');
          }
          throw error;
        } finally {
          clearTimeout(timer);
          sessions.dispose();
        }
      })().finally(() => {
        inflight = null;
      });
      return inflight;
    },

    async logout(): Promise<SessionView> {
      const sessions = openSession();
      try {
        await sessions.logout();
        return await sessions.view();
      } finally {
        sessions.dispose();
      }
    },
  };
}

export const devinAccount = createDevinAccount(() => {
  const sessions = new Sessions({ successText: DEVIN_OAUTH_SUCCESS });
  return {
    view: () => sessions.view(),
    login: (signal, notify) => sessions.login(signal, 'loopback', notify),
    logout: () => sessions.logout(),
    dispose: () => sessions.dispose(),
  };
});
