import { Icon } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import { Bot, Brain, Bug, ListChecks, MessageCircleQuestion, type LucideIcon } from 'lucide-react';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { pi } from '../../../../lib/pi';
import { AGENT_MODES, MODE_LABELS, useModeStore, type AgentMode } from '../../../../stores/modeStore';

/** 每个模式的 lucide 图标（统一经 @lobehub/ui 的 Icon 渲染，不用 emoji）。 */
const MODE_ICONS: Record<AgentMode, LucideIcon> = {
  agent: Bot,
  ask: MessageCircleQuestion,
  debug: Bug,
  plan: ListChecks,
  brainstorm: Brain,
};

/**
 * 模式选择器：Agent / Ask / Debug / Plan / Brainstorm 互斥单选，每项带图标。
 * 当前模式由 sidecar 的 agent-mode 扩展经 setStatus 推送到 modeStore（切会话/刷新后回读）；
 * 切换走 agent_set_mode（底层 /mode 命令，不调 LLM），并乐观更新本地状态即时反馈。
 */
export default function ModeAction() {
  const { workspace, workspaceReady } = useAgentStoreContext();
  const mode = useModeStore((s) => s.byWorkspace[workspace] ?? 'agent');

  const onChange = (next: string) => {
    const target = next as AgentMode;
    useModeStore.getState().setMode(workspace, target);
    void pi.setMode(workspace, target);
  };

  const options = AGENT_MODES.map((m) => ({ label: MODE_LABELS[m], value: m }));

  return (
    <Select
      size="small"
      popupMatchSelectWidth={false}
      disabled={!workspaceReady}
      value={mode}
      options={options}
      optionRender={(option) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Icon icon={MODE_ICONS[option.value as AgentMode]} size={14} />
          {MODE_LABELS[option.value as AgentMode]}
        </span>
      )}
      placeholder="模式"
      prefix={MODE_ICONS[mode]}
      style={{ width: 'auto', maxWidth: 120 }}
      onChange={onChange}
    />
  );
}
