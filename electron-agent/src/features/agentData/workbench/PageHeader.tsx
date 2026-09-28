import type { ReactNode } from 'react';
import { workbenchStyles as s } from './workbenchStyles';

interface Props { title: ReactNode; subtitle?: ReactNode; extra?: ReactNode; actions?: ReactNode }
/** 页头：标题、计数或说明、紧随标题的标签（extra）、右侧操作。 */
export function PageHeader({ title, subtitle, extra, actions }: Props) {
  return <header className={s.header}>
    <h2>{title}</h2>
    {extra}
    {subtitle ? <span className={s.subtitle}>{subtitle}</span> : null}
    {actions ? <div className={s.actions}>{actions}</div> : null}
  </header>;
}
