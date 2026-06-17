import { BarChart3, Brain, FileSearch, History, Image, Library, type LucideIcon, MessageSquare, Plug, Settings, Webhook } from 'lucide-react';
import { type ModuleId, useModuleStore } from '../../stores/moduleStore';

interface ModuleDef {
  id: ModuleId;
  label: string;
  Icon: LucideIcon;
  footer?: boolean;
}

const MODULES: ModuleDef[] = [
  { id: 'chat', label: '对话', Icon: MessageSquare },
  { id: 'knowledge', label: '知识库', Icon: Library },
  { id: 'memory', label: '记忆', Icon: Brain },
  { id: 'review', label: '审查', Icon: FileSearch },
  { id: 'create', label: '创作', Icon: Image },
  { id: 'checkpoints', label: '检查点', Icon: History },
  { id: 'connections', label: '连接', Icon: Webhook },
  { id: 'extensions', label: '扩展', Icon: Plug },
  { id: 'usage', label: '用量', Icon: BarChart3 },
  { id: 'settings', label: '设置', Icon: Settings, footer: true },
];

export function ModuleRail() {
  const activeModule = useModuleStore((s) => s.activeModule);
  const setActiveModule = useModuleStore((s) => s.setActiveModule);

  const renderButton = ({ id, label, Icon }: ModuleDef) => {
    const active = activeModule === id;
    return (
      <button
        key={id}
        data-testid={`module-${id}`}
        title={label}
        aria-label={label}
        aria-pressed={active}
        onClick={() => setActiveModule(id)}
        style={{
          width: 42,
          height: 42,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          borderRadius: 10,
          cursor: 'pointer',
          background: active ? 'var(--gren-rail-active, rgba(255,255,255,0.08))' : 'transparent',
          color: active ? 'var(--gren-fg, inherit)' : 'var(--gren-fg-muted, #9aa1ac)',
        }}
      >
        <Icon size={20} />
      </button>
    );
  };

  return (
    <div
      data-testid="module-rail"
      style={{
        width: 56,
        flex: '0 0 auto',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        padding: '10px 0',
        background: 'var(--gren-sidebar-bg, transparent)',
        borderRight: '1px solid var(--gren-border, rgba(255,255,255,0.08))',
      }}
    >
      {MODULES.filter((m) => !m.footer).map(renderButton)}
      <div style={{ flex: 1 }} />
      {MODULES.filter((m) => m.footer).map(renderButton)}
    </div>
  );
}
