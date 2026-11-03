import { createStaticStyles, cssVar, cx } from 'antd-style';
import { BarChart3, BrainCircuit, type LucideIcon, MessageSquare, Plug, Settings, SquareTerminal } from 'lucide-react';
import { type ModuleId, useModuleStore } from '../../stores/moduleStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { IS_DEV } from '../../lib/devMode';

interface ModuleDef {
  id: ModuleId;
  label: string;
  Icon: LucideIcon;
  footer?: boolean;
  /** 仅 DEV 构建渲染入口。生产构建里 IS_DEV 被折叠为 false，这一项连同它 import 的面板一起被 tree-shake。 */
  devOnly?: boolean;
}

// 全局 Agent Data 中心统一管理本地 CodeGraph 与 Wiki。
// IM（微信 / HTTP 网关）已从产品路径卸下，侧栏不再露「连接」。接回见 docs/im-reintroduction.md。
const MODULES: ModuleDef[] = [
  { id: 'chat', label: '对话', Icon: MessageSquare },
  { id: 'extensions', label: '扩展', Icon: Plug },
  { id: 'usage', label: '用量', Icon: BarChart3 },
  { id: 'agentData', label: 'Agent 数据', Icon: BrainCircuit },
  { id: 'devWorkbench', label: '开发者工作台', Icon: SquareTerminal, footer: true, devOnly: true },
  { id: 'settings', label: '设置', Icon: Settings, footer: true },
];

// 改用 createStaticStyles（与 dockTabStyles 等同一套写法）而非内联 style：内联写不出 hover，
// 且原先激活态只有 colorFillTertiary（暗色下约 6% 白）+ colorText，几乎看不出选中。
// 激活态用柔和强调色底和图标色，和会话栏的中性选中态区分。
const styles = createStaticStyles(({ css }) => ({
  rail: css`
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    align-items: center;
    gap: 12px;

    width: 52px;
    height: 100%;
    padding: 10px 0;

    background: var(--gren-rail-bg, ${cssVar.colorBgLayout});
  `,
  spacer: css`
    flex: 1;
  `,
  item: css`
    position: relative;

    display: flex;
    align-items: center;
    justify-content: center;

    width: 36px;
    height: 36px;
    border: none;
    border-radius: 8px;

    color: ${cssVar.colorTextSecondary};

    background: transparent;

    cursor: pointer;
    transition:
      background 0.15s ease,
      color 0.15s ease;

    &:hover {
      color: ${cssVar.colorText};
      background: var(--gren-sidebar-hover-bg, ${cssVar.colorFillTertiary});
    }
  `,
  itemActive: css`
    color: var(--gren-accent, ${cssVar.colorPrimary});
    background: color-mix(in srgb, var(--gren-accent, ${cssVar.colorPrimary}) 12%, transparent);

    &:hover {
      color: var(--gren-accent, ${cssVar.colorPrimary});
      background: color-mix(in srgb, var(--gren-accent, ${cssVar.colorPrimary}) 16%, transparent);
    }
  `,
}));

export function ModuleRail() {
  const activeModule = useModuleStore((s) => s.activeModule);
  const setActiveModule = useModuleStore((s) => s.setActiveModule);
  const modules = IS_DEV ? MODULES : MODULES.filter((module) => !module.devOnly);

  const renderButton = ({ id, label, Icon }: ModuleDef) => {
    const active = activeModule === id;
    const chatTab = id === 'chat';
    return (
      <button
        key={id}
        data-testid={`module-${id}`}
        title={label}
        aria-label={label}
        aria-pressed={active}
        onClick={() => {
          if (!chatTab) useLayoutStore.getState().closeSidebarDrawer();
          setActiveModule(id);
        }}
        onPointerEnter={
          chatTab
            ? () => {
                const layout = useLayoutStore.getState();
                if (useModuleStore.getState().activeModule !== 'chat') return;
                if (layout.sidebarDrawer === 'toggle' || layout.sidebarOpen) return;
                layout.cancelSidebarHoverClose();
                layout.openSidebarDrawer('hover');
              }
            : undefined
        }
        onPointerLeave={
          chatTab
            ? (event) => {
                const next = event.relatedTarget;
                if (next instanceof Element && next.closest('[data-sidebar-drawer]')) return;
                useLayoutStore.getState().scheduleSidebarHoverClose();
              }
            : undefined
        }
        className={cx(styles.item, active && styles.itemActive)}
      >
        <Icon size={18} />
      </button>
    );
  };

  return (
    <div data-testid="module-rail" className={styles.rail}>
      {modules.filter((m) => !m.footer).map(renderButton)}
      <div className={styles.spacer} />
      {modules.filter((m) => m.footer).map(renderButton)}
    </div>
  );
}
