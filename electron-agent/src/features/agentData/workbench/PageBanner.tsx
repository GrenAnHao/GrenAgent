import type { ReactNode } from 'react';
import { Alert } from 'antd';
import { workbenchStyles as s } from './workbenchStyles';

export interface BannerItem { source?: string; message: ReactNode }
interface Props { type: 'error' | 'warning' | 'info'; items: BannerItem[]; action?: ReactNode }
/** 同一类型的多条消息合成一条横幅；每个来源一行。没有消息时不渲染。 */
export function PageBanner({ type, items, action }: Props) {
  if (!items.length) return null;
  const content = items.length === 1 && !items[0].source
    ? items[0].message
    : <div>{items.map((item, index) => <div key={`${item.source ?? ''}:${index}`}>{item.source ? `${item.source}：` : ''}{item.message}</div>)}</div>;
  return <Alert className={s.banner} type={type} showIcon title={content} action={action} role={type === 'info' ? 'status' : 'alert'} />;
}
