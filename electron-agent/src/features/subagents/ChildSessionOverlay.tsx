import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { ArrowLeft, Square } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { groupMessages } from '../chat/groupMessages';
import { ChatMessageItems } from '../chat/ChatMessageItems';
import { computeAnsweredQuestions, computeSubAgentUnits } from '../chat/messagePrecompute';
import { useChildSessionBinding } from '../panels/useChildSessionBinding';
import { pi } from '../../lib/pi';
import { useSessionStore } from '../../store/session';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import { deriveTornDown, useChildOverlayStore } from '../../stores/childOverlayStore';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    background: ${cssVar.colorBgLayout};
  `,
  header: css`
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    padding: 6px 12px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  back: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: ${cssVar.colorText};
    font: inherit;
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  title: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 600;
  `,
  meta: css`
    flex: 0 0 auto;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
    white-space: nowrap;
  `,
  stop: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 4px;
    background: transparent;
    color: ${cssVar.colorText};
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  `,
  body: css`
    flex: 1;
    min-height: 0;
    position: relative;
  `,
  footer: css`
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  hint: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  error: css`
    font-size: 12px;
    color: ${cssVar.colorError};
  `,
  compose: css`
    display: flex;
    align-items: flex-end;
    gap: 8px;
  `,
  textarea: css`
    flex: 1;
    min-height: 56px;
    max-height: 160px;
    resize: vertical;
    padding: 8px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorBgContainer};
    color: ${cssVar.colorText};
    font: inherit;
  `,
  send: css`
    flex: 0 0 auto;
    height: 32px;
    padding: 0 12px;
    border: none;
    border-radius: 6px;
    background: ${cssVar.colorPrimary};
    color: ${cssVar.colorTextLightSolid};
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  `,
}));

export function ChildSessionOverlay({ onClose }: { onClose?: () => void } = {}) {
  const overlay = useChildOverlayStore((s) => s.overlay);
  const error = useChildOverlayStore((s) => s.error);
  const workspace = useOptionalAgentStoreContext()?.workspace ?? '';
  const [draft, setDraft] = useState('');

  const parentTitle = useSessionStore((s) => {
    const path = overlay?.parentSessionPath;
    if (!path) return '父会话';
    const found = s.allSessions.find((item) => item.path === path);
    const name = found?.name?.trim();
    return name || '父会话';
  });

  const messages = useChildSessionBinding(overlay?.sessionPath, overlay?.activity === 'running');
  const display = useMemo(() => groupMessages(messages), [messages]);
  const unitsByMessage = useMemo(() => computeSubAgentUnits(display), [display]);
  const answeredQuestions = useMemo(() => computeAnsweredQuestions(display), [display]);

  useEffect(() => {
    if (!overlay?.sessionPath) return;
    const sessionPath = overlay.sessionPath;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const row = await pi.subagentCatalogRow(sessionPath);
          const store = useChildOverlayStore.getState();
          if (store.overlay?.sessionPath !== sessionPath) return;
          store.setActivity(row.activity);
          store.setTornDown(deriveTornDown(store.overlay.mode, row.activity));
        } catch {
          /* keep last */
        }
      })();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [overlay?.sessionPath]);

  if (!overlay) return null;

  const close = () => {
    useChildOverlayStore.getState().close();
    onClose?.();
  };

  const blocked = overlay.tornDown || overlay.activity === 'unavailable';
  const readonly = blocked || overlay.mode === 'one-shot';
  const steer = overlay.activity === 'running';
  const sendLabel = steer ? '引导' : '发送';

  const submit = async () => {
    const text = draft.trim();
    if (!text || readonly) return;
    try {
      await pi.subagentPrompt(
        workspace,
        overlay.parentSessionPath,
        overlay.sessionPath,
        text,
        steer ? 'steer' : 'followUp',
      );
      const store = useChildOverlayStore.getState();
      store.setError(null);
      store.setActivity('running');
      setDraft('');
    } catch (err) {
      useChildOverlayStore.getState().setError(err instanceof Error ? err.message : String(err));
    }
  };

  const interrupt = async () => {
    try {
      await pi.subagentInterrupt(workspace, overlay.parentSessionPath, overlay.sessionPath);
      useChildOverlayStore.getState().setError(null);
    } catch (err) {
      useChildOverlayStore.getState().setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className={styles.root} data-testid="subagent-child-overlay">
      <div className={styles.header}>
        <button type="button" className={styles.back} onClick={close}>
          <Icon icon={ArrowLeft} size={14} />
          返回 {parentTitle}
        </button>
        <span className={styles.title}>{overlay.label}</span>
        <span className={styles.meta}>{overlay.mode}</span>
        <span className={styles.meta}>{overlay.activity}</span>
        <span className={styles.meta}>{readonly ? '只读' : '可续聊'}</span>
        {overlay.activity === 'running' ? (
          <button type="button" className={styles.stop} onClick={() => void interrupt()}>
            <Icon icon={Square} size={12} />
            停止
          </button>
        ) : null}
      </div>
      <div className={styles.body}>
        <ChatMessageItems
          messages={display}
          unitsByMessage={unitsByMessage}
          answeredQuestions={answeredQuestions}
          paddingInline={16}
          resetKey={overlay.sessionPath}
        />
      </div>
      <div className={styles.footer}>
        {error ? <div className={styles.error}>{error}</div> : null}
        {blocked ? (
          <div className={styles.hint}>无法继续</div>
        ) : overlay.mode === 'one-shot' ? (
          <div className={styles.hint}>此子代理只读</div>
        ) : (
          <div className={styles.compose}>
            <textarea
              className={styles.textarea}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="button" className={styles.send} onClick={() => void submit()}>
              {sendLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
