import { Button, Dropdown, type MenuProps } from 'antd';
import { Ellipsis } from 'lucide-react';

export interface MoreMenuItem { key: string; label: string; danger?: boolean; disabled?: boolean; title?: string }
interface Props { label: string; items: MoreMenuItem[]; onSelect(key: string): void; disabled?: boolean }
/** “⋯”菜单：普通项在前，危险项在分隔线后。 */
export function MoreMenu({ label, items, onSelect, disabled }: Props) {
  const normal = items.filter((item) => !item.danger);
  const danger = items.filter((item) => item.danger);
  const toEntry = (item: MoreMenuItem) => ({ key: item.key, label: <span title={item.title}>{item.label}</span>, danger: item.danger, disabled: item.disabled });
  const menuItems: MenuProps['items'] = [
    ...normal.map(toEntry),
    ...(normal.length && danger.length ? [{ type: 'divider' as const }] : []),
    ...danger.map(toEntry),
  ];
  return <Dropdown trigger={['click']} disabled={disabled} menu={{ items: menuItems, onClick: ({ key, domEvent }) => { domEvent.stopPropagation(); onSelect(key); } }}>
    <Button aria-label={label} title={label} icon={<Ellipsis size={16} />} onClick={(event) => event.stopPropagation()} />
  </Dropdown>;
}
