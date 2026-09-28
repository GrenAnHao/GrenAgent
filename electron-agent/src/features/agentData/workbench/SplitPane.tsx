import type { ReactNode } from 'react';
import { workbenchStyles as s } from './workbenchStyles';

interface Props { detailOpen: boolean; side: ReactNode; main: ReactNode; className?: string }
/** 左列表右详情；容器窄于 800px 时由 data-detail 决定显示哪一栏。 */
export function SplitPane({ detailOpen, side, main, className }: Props) {
  return <div className={`${s.split} ${className ?? ''}`} data-detail={detailOpen}>
    <div data-split-side>{side}</div>
    <div data-split-main>{main}</div>
  </div>;
}
