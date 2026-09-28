import { Tag } from 'antd';

type Entry = readonly [label: string, color: string];
const maps: Record<string, Record<string, Entry>> = {
  wiki: { draft: ['草稿', 'default'], pending: ['待抽取', 'warning'], processing: ['处理中', 'processing'], ready: ['可用', 'success'], failed: ['失败', 'error'] },
  diagnostic: { action_required: ['需要处理', 'error'], unchecked: ['未检查', 'default'], ok: ['正常', 'success'] },
};
/** 域状态 → 中文标签与 antd 预设色；未知值原样显示为默认色。 */
export function StatusTag({ domain, status }: { domain: keyof typeof maps; status: string }) {
  const [label, color] = maps[domain][status] ?? [status, 'default'];
  return <Tag color={color}>{label}</Tag>;
}
export function statusLabel(domain: keyof typeof maps, status: string): string {
  return maps[domain][status]?.[0] ?? status;
}
