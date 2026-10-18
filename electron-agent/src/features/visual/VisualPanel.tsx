import { memo, useCallback, useEffect } from 'react';
import { createStaticStyles, cssVar } from 'antd-style';
import { HtmlPreview } from '@lobehub/ui';
import { useVisualStore } from '../../stores/visualStore';
import { buildSrcDoc } from './frameAssets';
import { parseVisualChoiceMessage, submitVisualChoice } from './submitVisualChoice';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    background: ${cssVar.colorBgContainer};
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};
    flex-shrink: 0;
  `,
  title: css`
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: ${cssVar.colorTextSecondary};
  `,
  dot: css`
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${cssVar.colorPrimary};
  `,
  frame: css`
    flex: 1;
    width: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
  `,
  empty: css`
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

/**
 * 右侧「视觉设计」面板。内容、等待状态、回写目标都取自 visualKey 对应的条目（发起会话登记的），
 * 不读「当前会话」：用户切到别的会话 / 项目再回来点确认，结果仍回写到发起视觉设计的会话。
 */
export const VisualPanel = memo(function VisualPanel({ visualKey }: { visualKey: string }) {
  const entry = useVisualStore((s) => s.entries[visualKey]);
  const submitted = useVisualStore((s) => (entry ? s.submittedIds.has(entry.rev) : false));
  const html = entry?.html ?? '';
  const rev = entry?.rev ?? 0;
  const pending = entry?.pending ?? false;

  const onMessage = useCallback(
    (e: MessageEvent) => {
      const message = parseVisualChoiceMessage(e.data);
      if (!message) return;
      // 读最新条目：面板重新挂载 / 别的会话改过 store 之后，闭包里的旧值不可信。
      const latest = useVisualStore.getState().entries[visualKey];
      if (!latest || useVisualStore.getState().submittedIds.has(latest.rev)) return;
      submitVisualChoice(latest, message);
    },
    [visualKey],
  );

  useEffect(() => {
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onMessage]);

  return (
    <div className={styles.root}>
      {submitted || pending ? (
        <div className={styles.header}>
          <span className={styles.title}>
            <span className={styles.dot} />
            {submitted ? '已选择' : '等待选择'}
          </span>
        </div>
      ) : null}
      {html ? (
        <HtmlPreview
          key={rev}
          animated={false}
          className={styles.frame}
          copyable={false}
          defaultHeight={320}
          defaultMode="preview"
          downloadable={false}
          style={{ flex: 1, height: '100%', minHeight: 0 }}
          // 已提交过的页面重新挂载后 iframe 是全新的（确认条又可点了）：锁住，不能再点出一个没人接收的回答。
          styles={{
            iframe: {
              flex: 1,
              width: '100%',
              height: '100%',
              minHeight: 0,
              opacity: submitted ? 0.45 : 1,
              pointerEvents: submitted ? 'none' : 'auto',
            },
          }}
          theme="dark"
          variant="borderless"
        >
          {buildSrcDoc(html, { fill: true })}
        </HtmlPreview>
      ) : (
        <div className={styles.empty}>等待 Agent 推送内容…</div>
      )}
    </div>
  );
});
