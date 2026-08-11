import { createStaticStyles, cssVar, cx } from 'antd-style';
import { BarChart3, Brain, type LucideIcon, MessageSquare, Plug, Settings, Webhook } from 'lucide-react';
import { type ModuleId, useModuleStore } from '../../stores/moduleStore';

interface ModuleDef {
  id: ModuleId;
  label: string;
  Icon: LucideIcon;
  footer?: boolean;
}

// 仅全局（应用级）模块常驻 rail；纯项目级工具（检查点/审查/知识库）改由主列 WorkspaceTabs 承载。
// 记忆以全局长期记忆为主体（项目记忆仅附加），故仍归全局 rail。
const MODULES: ModuleDef[] = [
  { id: 'chat', label: '对话', Icon: MessageSquare },
  { id: 'memory', label: '记忆', Icon: Brain },
  { id: 'connections', label: '连接', Icon: Webhook },
  { id: 'extensions', label: '扩展', Icon: Plug },
  { id: 'usage', label: '用量', Icon: BarChart3 },
  { id: 'settings', label: '设置', Icon: Settings, footer: true },
];

// 改用 createStaticStyles（与 dockTabStyles 等同一套写法）而非内联 style：内联写不出 hover，
// 且原先激活态只有 colorFillTertiary（暗色下约 6% 白）+ colorText，几乎看不出选中。
// 现在激活态 = colorFill 实感底 + 左侧主色指示条 + 高对比图标色，未激活/hover 各自分层。
const styles = createStaticStyles(({ css }) => ({
  rail: css`
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    align-items: center;
    gap: 6px;

    width: 56px;
    height: 100%;
    padding: 10px 0;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};

    background: var(--gren-sidebar-bg, ${cssVar.colorBgLayout});
  `,
  spacer: css`
    flex: 1;
  `,
  item: css`
    position: relative;

    display: flex;
    align-items: center;
    justify-content: center;

    width: 42px;
    height: 42px;
    border: none;
    border-radius: 10px;

    color: ${cssVar.colorTextSecondary};

    background: transparent;

    cursor: pointer;
    transition:
      background 0.15s ease,
      color 0.15s ease;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillTertiary};
    }
  `,
  itemActive: css`
    color: ${cssVar.colorText};
    background: ${cssVar.colorFill};

    /* 左侧主色指示条：只靠底色区分在暗色下辨识度不足，加一条竖条一眼看出当前模块。 */
    &::before {
      content: '';

      position: absolute;
      inset-block: 9px;
      /* rail 56px / 按钮 42px → 左右各 7px 余量；-5 让指示条离窗口边缘留 2px。 */
      inset-inline-start: -5px;

      width: 3px;
      border-radius: 0 3px 3px 0;

      background: ${cssVar.colorPrimary};
    }

    &:hover {
      background: ${cssVar.colorFill};
    }
  `,
}));

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
        className={cx(styles.item, active && styles.itemActive)}
      >
        <Icon size={20} />
      </button>
    );
  };

  return (
    <div data-testid="module-rail" className={styles.rail}>
      {MODULES.filter((m) => !m.footer).map(renderButton)}
      <div className={styles.spacer} />
      {MODULES.filter((m) => m.footer).map(renderButton)}
    </div>
  );
}
