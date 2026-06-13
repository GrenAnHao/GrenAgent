import type { ReactNode } from 'react';
import { useModuleStore } from '../../stores/moduleStore';
import { KnowledgePanel } from '../knowledge/KnowledgePanel';
import { MemoryPanel } from '../memory/MemoryPanel';
import { ReviewPanel } from '../review/ReviewPanel';
import { CreatePanel } from '../create/CreatePanel';
import { SettingsPanel } from '../settings/SettingsPanel';
import { ConnectionsPanel } from '../connections/ConnectionsPanel';
import { ExtensionsPanel } from '../extensions/ExtensionsPanel';

export function ModuleContainer({ chat }: { chat: ReactNode }) {
  const activeModule = useModuleStore((s) => s.activeModule);
  switch (activeModule) {
    case 'chat':
      return <>{chat}</>;
    case 'knowledge':
      return <KnowledgePanel />;
    case 'memory':
      return <MemoryPanel />;
    case 'review':
      return <ReviewPanel />;
    case 'create':
      return <CreatePanel />;
    case 'settings':
      return <SettingsPanel />;
    case 'connections':
      return <ConnectionsPanel />;
    case 'extensions':
      return <ExtensionsPanel />;
    default:
      return <>{chat}</>;
  }
}
