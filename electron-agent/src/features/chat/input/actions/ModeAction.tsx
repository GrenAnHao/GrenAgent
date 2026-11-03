import { useEffect, useState } from 'react';
import { App } from 'antd';
import { Icon } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import { Bot, Bug, ListChecks, MessageCircleQuestion, Sparkles, type LucideIcon } from 'lucide-react';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import {
  AGENT_MODES,
  MODE_LABELS,
  type AgentMode,
} from '../../../../stores/modeStore';
import { compactLabelStyles, useComposerCompact } from '../composerCompact';
import { useComposerOwnerKey, useComposerOwnerPreferences } from '../composerOwner';
import { ensureComposerPreferences, writeComposerPreference } from './composerPreferences';

/** 每个模式的 lucide 图标（统一经 @lobehub/ui 的 Icon 渲染，不用 emoji）。导出供单测检查每个模式都有独立图标。 */
export const MODE_ICONS: Record<AgentMode, LucideIcon> = {
  agent: Bot,
  ask: MessageCircleQuestion,
  debug: Bug,
  plan: ListChecks,
  // Ultra：与 Agent 并列的独立执行模式，多代理编排，用闪光标记区分。
  ultra: Sparkles,
};

/** agent_set_mode 被未确认计划拦下时的回执（见 piRuntimeService.writeAgentMode）。 */
export function readBlocked(result: unknown): { mode: AgentMode; message: string } | null {
  const r = result as { ok?: unknown; blocked?: unknown; mode?: unknown; message?: unknown } | null;
  if (!r || r.ok !== false || r.blocked !== 'PLAN_UNCONFIRMED') return null;
  const mode = AGENT_MODES.includes(r.mode as AgentMode) ? (r.mode as AgentMode) : 'plan';
  return { mode, message: typeof r.message === 'string' ? r.message : '当前有未确认的计划，请在右侧计划面板确认执行。' };
}

/**
 * 模式选择器：Agent / Ask / Debug / Plan / Ultra 互斥单选，每项带图标。
 * Ultra 是独立模式（不是额外开关）：选它就退出 Ask/Plan，工具能力同 Agent，子代理模型走自己的设置分组。
 *
 * 模式归属：读会话/草稿的 `session-preferences` 快照（sessionPreferencesStore）。
 *  - 恢复只显示保存值，不调 setter；
 *  - 普通会话修改只改这一份会话（agent_set_mode 带原始 sessionPath），不动项目默认；
 *  - 草稿只写本地偏好，首发由主线程过户；
 *  - 未确认 Plan 的拒绝沿用旧行为：回滚 + 提示；
 *  - 加载中禁用，保存失败可见。
 */
export default function ModeAction() {
  const { workspace, workspaceReady } = useAgentStoreContext();
  const ownerKey = useComposerOwnerKey(workspace);
  const { preferences, loading: preferencesLoading, error: preferencesError } = useComposerOwnerPreferences(workspace);
  const [loadFailed, setLoadFailed] = useState(false);
  const compact = useComposerCompact();
  const { message } = App.useApp();

  useEffect(() => {
    if (!workspaceReady) return;
    let cancelled = false;
    setLoadFailed(false);
    void ensureComposerPreferences(workspace, ownerKey).then((result) => {
      if (cancelled) return;
      if (result.ok) return;
      setLoadFailed(true);
      message.error(result.message ? `无法读取模式：${result.message}` : '无法读取会话模式，请重试');
    });
    return () => {
      cancelled = true;
    };
  }, [workspace, workspaceReady, ownerKey]);

  const mode: AgentMode = preferences.mode ?? 'agent';
  const loading = preferencesLoading || !preferences.mode;
  const disabled = !workspaceReady || loadFailed || loading || preferencesError === 'load';

  const onChange = (next: string) => {
    const target = next as AgentMode;
    void writeComposerPreference(workspace, ownerKey, 'mode', target).then((result) => {
      if (result.ok) return;
      if (result.error === 'blocked') {
        // 会话有未确认的计划：宿主取消了这次切换，已回滚乐观值，这里只负责提示。
        message.warning(result.message ?? '当前有未确认的计划，请在右侧计划面板确认执行。');
        return;
      }
      if (result.error === 'loading') return;
      message.error(result.message ? `模式保存失败：${result.message}` : '模式保存失败，已保留原值');
    });
  };

  const options = AGENT_MODES.map((m) => ({ label: MODE_LABELS[m], value: m }));

  return (
    <Select
      size="small"
      variant="borderless"
      popupMatchSelectWidth={false}
      disabled={disabled}
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
