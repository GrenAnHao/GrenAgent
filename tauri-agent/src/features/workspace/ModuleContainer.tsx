import type { ReactNode } from 'react';
import { type ModuleId, useModuleStore } from '../../stores/moduleStore';
import { PlaceholderPanel } from './PlaceholderPanel';

const MODULE_TITLES: Record<Exclude<ModuleId, 'chat'>, string> = {
  knowledge: '知识库',
  memory: '记忆',
  review: '审查',
  create: '创作',
  connections: '连接',
  settings: '设置',
};

export function ModuleContainer({ chat }: { chat: ReactNode }) {
  const activeModule = useModuleStore((s) => s.activeModule);
  if (activeModule === 'chat') return <>{chat}</>;
  return <PlaceholderPanel title={MODULE_TITLES[activeModule]} />;
}
