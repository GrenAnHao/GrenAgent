import { Block, Icon } from '@lobehub/ui';
import { Spin } from '@lobehub/ui/base-ui';
import { cssVar } from 'antd-style';
import { Atom, Check, TriangleAlert, X } from 'lucide-react';

export type StatusKind = 'running' | 'done' | 'error' | 'partial' | 'thinking';

interface StatusIndicatorProps {
  status: StatusKind;
}

/** 工具/思考状态块：24×24 描边外框；运行中使用 LobeHub 的网络动画。 */
export function StatusIndicator({ status }: StatusIndicatorProps) {
  let icon;

  switch (status) {
    case 'done':
      icon = <Icon color={cssVar.colorSuccess} icon={Check} size={14} />;
      break;
    case 'error':
      icon = <Icon color={cssVar.colorError} icon={X} size={14} />;
      break;
    case 'partial':
      icon = <Icon color={cssVar.colorWarning} icon={TriangleAlert} size={14} />;
      break;
    case 'thinking':
      icon = <Icon color={cssVar.colorTextSecondary} icon={Atom} size={14} />;
      break;
    case 'running':
    default:
      icon = <Spin variant="network" size={16} />;
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
