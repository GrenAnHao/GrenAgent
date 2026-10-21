import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { CircleX, Hand, LoaderCircle, MessageCircleQuestion, OctagonPause } from 'lucide-react';
import type { RowStatusKind } from '../../stores/attentionView';

const styles = createStaticStyles(({ css }) => ({
  icon: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
  `,
  approval: css`
    color: ${cssVar.orange};
  `,
  choice: css`
    color: ${cssVar.colorInfo};
    animation: piAttentionBreathe 1.6s ease-in-out infinite alternate;

    @keyframes piAttentionBreathe {
      from {
        opacity: 1;
      }
      to {
        opacity: 0.45;
      }
    }
  `,
  failed: css`
    color: ${cssVar.colorError};
  `,
  blocked: css`
    color: ${cssVar.purple};
  `,
  running: css`
    color: ${cssVar.colorWarning};
    animation: piSidebarSpin 1.1s linear infinite;

    @keyframes piSidebarSpin {
      to {
        transform: rotate(360deg);
      }
    }
  `,
  dot: css`
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${cssVar.colorSuccess};
  `,
}));

const ICONS = {
  approval: Hand,
  choice: MessageCircleQuestion,
  failed: CircleX,
  blocked: OctagonPause,
  running: LoaderCircle,
} as const;

/** 会话行与折叠分组头共用的状态图标。颜色约定见 sessionAttention 的规格笔记。 */
export function AttentionIcon({ kind }: { kind: RowStatusKind }) {
  if (kind === 'done') return <span className={cx(styles.icon, styles.dot)} data-attention-icon="done" />;
  return (
    <span className={cx(styles.icon, styles[kind])} data-attention-icon={kind}>
      <Icon icon={ICONS[kind]} size="small" />
    </span>
  );
}
