import type { ReactNode } from 'react';
import { type ModuleId, useModuleStore } from '../../stores/moduleStore';
import { PlaceholderPanel } from './PlaceholderPanel';
import { KnowledgePanel } from '../knowledge/KnowledgePanel';
import { MemoryPanel } from '../memory/MemoryPanel';
import { ReviewPanel } from '../review/ReviewPanel';
import { CreatePanel } from '../create/CreatePanel';

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
  if (activeModule === 'knowledge') return <KnowledgePanel />;
  if (activeModule === 'memory') return <MemoryPanel />;
  if (activeModule === 'review') return <ReviewPanel />;
  if (activeModule === 'create') return <CreatePanel />;
  return <PlaceholderPanel title={MODULE_TITLES[activeModule]} />;
}
