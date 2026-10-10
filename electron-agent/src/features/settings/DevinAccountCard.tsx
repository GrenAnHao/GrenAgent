import { useEffect, useState } from 'react';
import { createStyles } from 'antd-style';
import { pi } from '../../lib/pi';
import type { DevinAccountView } from '../../lib/devinAccount';

const useStyles = createStyles(({ css, token }) => ({
  row: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-block: 10px;
  `,
  meta: css`
    flex: 1 1 auto;
    min-width: 0;
  `,
  label: css`
    font-size: var(--pi-font-size, 14px);
    color: ${token.colorText};
  `,
  desc: css`
    margin-block-start: 2px;
    font-size: var(--pi-font-size-secondary, 13px);
    color: ${token.colorTextDescription};
  `,
  error: css`
    margin-block-start: 2px;
    font-size: var(--pi-font-size-secondary, 13px);
    color: ${token.colorError};
  `,
  actions: css`
    display: flex;
    flex: 0 0 auto;
    gap: 8px;
  `,
  btn: css`
    padding: 5px 14px;
    border: 1px solid ${token.colorBorder};
    border-radius: ${token.borderRadius}px;
    cursor: pointer;
    background: ${token.colorFillSecondary};
    color: ${token.colorText};
    font-size: 12px;
    &:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }
  `,
}));

function statusText(view: DevinAccountView | null, failed: boolean, busy: boolean): string {
  if (busy) return '正在等待 Devin OAuth 授权。请在弹出的窗口中完成登录。';
  if (!view) return failed ? '无法读取登录状态。' : '正在读取登录状态…';
  if (view.state === 'ok') return `已登录，到期 ${view.expiresAt ?? ''}。登录不会自动刷新。`;
  if (view.state === 'expired') return `登录已过期（${view.expiresAt ?? ''}）。请重新进行 OAuth 登录，不会自动刷新。`;
  if (view.state === 'revoked') return '登录已被服务端拒绝。请重新进行 OAuth 登录，不会自动刷新。';
  return '未登录。点 OAuth 登录，在弹出的窗口里完成 Devin 授权。登录后网页搜索会先试 Devin。登录不会自动刷新。';
}

export function DevinAccountCard() {
  const { styles } = useStyles();
  const [view, setView] = useState<DevinAccountView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void pi.devinAccountStatus().then(
      (next) => {
        if (!cancelled) setView(next);
      },
      (reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(action: () => Promise<DevinAccountView>) {
    setBusy(true);
    setError('');
    try {
      setView(await action());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.row} data-testid="devin-account">
      <div className={styles.meta}>
        <div className={styles.label}>Devin 账号</div>
        <div className={styles.desc} data-testid="devin-account-status">{statusText(view, error.length > 0, busy)}</div>
        {error ? <div className={styles.error}>{error}</div> : null}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.btn}
          data-testid="devin-account-login"
          disabled={busy}
          onClick={() => void run(() => pi.devinAccountLogin())}
        >
          OAuth 登录
        </button>
        <button
          type="button"
          className={styles.btn}
          data-testid="devin-account-logout"
          disabled={busy}
          onClick={() => void run(() => pi.devinAccountLogout())}
        >
          退出
        </button>
      </div>
    </div>
  );
}
