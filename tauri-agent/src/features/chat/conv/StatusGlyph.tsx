import { Icon } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { Check, Loader2, X } from 'lucide-react';
import { memo } from 'react';
import { convStyles } from './convTokens';

export type ConvStatus = 'running' | 'done' | 'error';

const COLOR: Record<ConvStatus, string> = {
  running: cssVar.colorInfo,
  done: cssVar.colorSuccess,
  error: cssVar.colorError,
};

/** 行首状态图标：运行=转圈(Info)、完成=勾(Success)、出错=叉(Error)。无彩色竖条。 */
export const StatusGlyph = memo(function StatusGlyph({ status }: { status: ConvStatus }) {
  const icon = status === 'running' ? Loader2 : status === 'error' ? X : Check;
  return (
    <span className={convStyles.lead} data-status={status} style={{ color: COLOR[status] }}>
      <Icon icon={icon} size={13} spin={status === 'running'} />
    </span>
  );
});
