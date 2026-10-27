import { App } from 'antd';
import { Icon } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import { Bot, Brain, Bug, ListChecks, MessageCircleQuestion, type LucideIcon } from 'lucide-react';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { pi } from '../../../../lib/pi';
import {
  AGENT_MODES,
  MODE_LABELS,
  useComposerMode,
  useComposerSessionPath,
  useModeStore,
  type AgentMode,
} from '../../../../stores/modeStore';
import { compactLabelStyles, useComposerCompact } from '../composerCompact';

/** 每个模式的 lucide 图标（统一经 @lobehub/ui 的 Icon 渲染，不用 emoji）。 */
const MODE_ICONS: Record<AgentMode, LucideIcon> = {
  agent: Bot,
  ask: MessageCircleQuestion,
  debug: Bug,
  plan: ListChecks,
  brainstorm: Brain,
};

/** agent_set_mode 被未确认计划拦下时的回执（见 piRuntimeService.writeAgentMode）。 */
export function readBlocked(result: unknown): { mode: AgentMode; message: string } | null {
  const r = result as { ok?: unknown; blocked?: unknown; mode?: unknown; message?: unknown } | null;
  if (!r || r.ok !== false || r.blocked !== 'PLAN_UNCONFIRMED') return null;
  const mode = AGENT_MODES.includes(r.mode as AgentMode) ? (r.mode as AgentMode) : 'plan';
  return { mode, message: typeof r.message === 'string' ? r.message : '当前有未确认的计划，请在右侧计划面板确认执行。' };
}

/**
 * 模式选择器：Agent / Ask / Debug / Plan / Brainstorm 互斥单选，每项带图标。
 * 模式按会话：当前会话的模式由 agent-mode 扩展经 setStatus（带 sessionPath）推送到 modeStore；
 * 切换走 agent_set_mode 并带上会话路径，只改这一份会话；同时更新项目默认（草稿与新会话继承）。
 */
export default function ModeAction() {
  const { workspace, workspaceReady } = useAgentStoreContext();
  const sessionPath = useComposerSessionPath(workspace);
  const mode = useComposerMode(workspace);
  const compact = useComposerCompact();
  const { message } = App.useApp();

  const onChange = (next: string) => {
    const target = next as AgentMode;
    const store = useModeStore.getState();
    const prevDefault = store.byWorkspace[workspace];
    // 项目默认同步更新（与宿主一致，最近一次选择给新会话继承）；已打开的其它会话不受影响。
    if (sessionPath) store.setSessionMode(sessionPath, target);
    store.setMode(workspace, target);
    void pi.setMode(workspace, target, sessionPath).then((result) => {
      const blocked = readBlocked(result);
      if (!blocked) return;
      // 会话有未确认的计划：宿主取消了这次切换，把乐观更新退回去，并指向侧栏确认。
      if (sessionPath) useModeStore.getState().setSessionMode(sessionPath, blocked.mode);
      if (prevDefault) useModeStore.getState().setMode(workspace, prevDefault);
      message.warning(blocked.message);
    }, () => {});
  };

  const options = AGENT_MODES.map((m) => ({ label: MODE_LABELS[m], value: m }));

  return (
    <Select
      size="small"
      variant="borderless"
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
      classNames={compact ? { value: compactLabelStyles.clip } : undefined}
      style={{ width: 'auto', maxWidth: compact ? 40 : 120, paddingInline: 0 }}
      suffixIcon={null}
      onChange={onChange}
    />
  );
}
