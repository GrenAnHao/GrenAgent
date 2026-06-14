import { Block, Icon, NeuralNetworkLoading } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { Atom, Check, X } from 'lucide-react';

export type StatusKind = 'running' | 'done' | 'error' | 'thinking';

interface StatusIndicatorProps {
  status: StatusKind;
}

/** 工具/思考状态块：对齐 lobe-chat —— 24×24 outlined Block + 真 NeuralNetworkLoading（运行中）。 */
export function StatusIndicator({ status }: StatusIndicatorProps) {
  let icon = <NeuralNetworkLoading size={16} />;

  switch (status) {
    case 'done':
      icon = <Icon color={cssVar.colorSuccess} icon={Check} size={14} />;
      break;
    case 'error':
      icon = <Icon color={cssVar.colorError} icon={X} size={14} />;
      break;
    case 'thinking':
      icon = <Icon color={cssVar.colorTextSecondary} icon={Atom} size={14} />;
      break;
    case 'running':
    default:
      icon = <NeuralNetworkLoading size={16} />;
      break;
  }

  return (
    <Block
      horizontal
      align="center"
      flex="none"
      gap={4}
      justify="center"
      variant="outlined"
      style={{ width: 24, height: 24, fontSize: 12 }}
    >
      {icon}
    </Block>
  );
}
