import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { Check, Loader2, Square, X } from 'lucide-react';
import { memo, type MouseEvent } from 'react';
import { convStyles } from './convTokens';

export type ConvStatus = 'running' | 'done' | 'error';

const COLOR: Record<ConvStatus, string> = {
  running: cssVar.colorInfo,
  done: cssVar.colorSuccess,
  error: cssVar.colorError,
};

const styles = createStaticStyles(({ css }) => ({
  // 默认只显示 spinner。悬停切换写在父级 ConvStrip（.conv-strip:hover），
  // 子级里的 `.conv-strip:hover &` 会把停止方块留在文档流里，运行中看起来像一颗方块。
  spinner: css`
    display: inline-flex;
  `,
  stop: css`
    display: none;
    color: ${cssVar.colorError};
    cursor: pointer;
  `,
}));

/** 行首状态图标；运行且可停止时，父行 hover 切换为红色停止键。 */
export const StatusGlyph = memo(function StatusGlyph({
  status,
  onStop,
}: {
  status: ConvStatus;
  onStop?: (e: MouseEvent) => void;
}) {
  if (status === 'running' && onStop) {
    return (
      <span className={convStyles.lead} data-status="running">
        <span className={styles.spinner} data-role="run-spinner" style={{ color: COLOR.running }}>
          <Icon icon={Loader2} size={13} spin />
        </span>
        <span
          className={styles.stop}
          data-role="run-stop"
          title="停止子代理"
          onClick={(e) => {
            e.stopPropagation();
            onStop(e);
          }}
        >
          <Icon icon={Square} size={12} fill={cssVar.colorError} />
        </span>
      </span>
    );
  }
  const icon = status === 'running' ? Loader2 : status === 'error' ? X : Check;
  return (
    <span className={convStyles.lead} data-status={status} style={{ color: COLOR[status] }}>
      <Icon icon={icon} size={13} spin={status === 'running'} />
    </span>
  );
});
