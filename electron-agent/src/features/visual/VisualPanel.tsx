import { memo } from 'react';
import { createStaticStyles, cssVar } from 'antd-style';
import { HtmlPreview } from '@lobehub/ui';
import { useVisualStore } from '../../stores/visualStore';
import { buildSrcDoc } from './frameAssets';

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
 * 右侧预览只读 visualKey 对应的原会话产出；评审答复始终在 ask_user 卡里完成。
 */
export const VisualPanel = memo(function VisualPanel({ visualKey }: { visualKey: string }) {
  const entry = useVisualStore((s) => s.entries[visualKey]);
  const html = entry?.html ?? '';
  const rev = entry?.rev ?? 0;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}><span className={styles.dot} />视觉预览 · 评审请在询问卡作答</span>
      </div>
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
          styles={{ iframe: { flex: 1, width: '100%', height: '100%', minHeight: 0 } }}
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
