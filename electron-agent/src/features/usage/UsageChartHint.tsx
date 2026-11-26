import { Tooltip } from 'antd';
import type { ReactElement } from 'react';

/** Exact values and full names in the legend and project ranking use the same opaque surface as the trend. */
export function UsageChartHint({ title, children }: { title: string; children: ReactElement }) {
  return <Tooltip title={title} arrow={false} zIndex={50} mouseEnterDelay={0.35}
    classNames={{root:'usage-chart-hint', container:'usage-chart-hint-body'}}
    motion={{motionName:''}} styles={{root:{pointerEvents:'none'}}}>
    {children}
  </Tooltip>;
}
