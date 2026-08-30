import { useCallback } from 'react';
import type { IEditor, ISlashMenuOption, ISlashOption } from '@lobehub/editor';
import { pi } from '../../../../lib/pi';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { useSessionStore } from '../../../../store/session';
import { isUnder } from '../../../../lib/pathUtils';
import { resolveCommandIcon } from '../commandIcons';
import { commandMatchesQuery, getFrontendCommands } from '../commandUtils';
import type { CommandApiSource, PiCommand } from '../commandTypes';
import { loadCommands } from './commandLoader';
import { INSERT_CHAT_TAG_COMMAND } from './ChatTag/command';

function stripSkillPrefix(name: string): string {
  return name.startsWith('skill:') ? name.slice(6) : name;
}

type GroupKey = CommandApiSource | 'frontend';

const GROUP_ORDER: GroupKey[] = ['frontend', 'extension', 'prompt', 'skill', 'builtin', 'unknown'];

/** 分组小标题文案（用户语义：系统命令 / 工具 / 技能…）。 */
const GROUP_LABELS: Record<GroupKey, string> = {
  frontend: '快捷操作',
  extension: '工具',
  prompt: '提示词',
  skill: '技能',
  builtin: '系统命令',
  unknown: '其他',
};

/** 分组小标题：复用 divider 类型（编辑器键盘导航会跳过 type:'divider'），带 label 供菜单渲染成标题。 */
type GroupHeaderOption = { type: 'divider'; label: string };

function groupHeader(label: string): GroupHeaderOption {
  return { type: 'divider', label };
}

function groupKey(c: PiCommand): GroupKey {
  return c.source === 'frontend' ? 'frontend' : (c.apiSource ?? 'unknown');
}

/** 描述过长会把菜单撑宽，截断展示（搜索仍用完整文本）。 */
function clampDesc(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s.length > 48 ? `${s.slice(0, 47)}…` : s;
}

/** 过滤 + 按类目分组（每组前插带标题的分隔项）+ 补功能图标/描述，喂给编辑器 slash 菜单渲染。 */
function toOptions(commands: PiCommand[], query: string): ISlashOption[] {
  const buckets = new Map<GroupKey, PiCommand[]>();
  for (const c of commands) {
    if (!commandMatchesQuery(c, query)) continue;
    const key = groupKey(c);
    const bucket = buckets.get(key) ?? [];
    bucket.push(c);
    buckets.set(key, bucket);
  }

  const out: ISlashOption[] = [];
  for (const key of GROUP_ORDER) {
    const items = buckets.get(key);
    if (!items?.length) continue;
    out.push(groupHeader(GROUP_LABELS[key]));
    for (const c of items) {
      const option: ISlashMenuOption = {
        key: c.source === 'frontend' ? `frontend:${c.name}` : `api:${c.name}`,
        label: c.apiSource === 'skill' ? stripSkillPrefix(c.name) : c.name,
        extra: clampDesc(c.description),
        icon: resolveCommandIcon(c),
        metadata: { kind: c.source === 'frontend' ? 'frontend' : 'api', name: c.name, group: key },
      };
      out.push(option);
    }
  }
  return out;
}

type SlashSearch = {
  leadOffset: number;
  matchingString: string;
  replaceableString: string;
} | null;

export function useSlashOptions(workspace: string, clear: () => void) {
  const { store } = useAgentStoreContext();
  const worksDir = useSessionStore((s) => s.worksDir);
  const isConversation = Boolean(worksDir && isUnder(workspace, worksDir));

  const slashItems = useCallback(
    async (search: SlashSearch): Promise<ISlashOption[]> => {
      const rawCommands = workspace ? await loadCommands(workspace) : getFrontendCommands();
      const commands = isConversation
        ? rawCommands.filter((command) => !command.name.startsWith('mcp__'))
        : rawCommands;
      return toOptions(commands, search?.matchingString ?? '');
    },
    [workspace, isConversation],
  );

  const onSelect = useCallback(
    (editor: IEditor, option: ISlashMenuOption) => {
      const meta = option.metadata as
        | { kind: 'frontend' | 'api'; name: string; group: CommandApiSource | 'frontend' }
        | undefined;
      if (!meta) return;

      if (meta.kind === 'frontend') {
        if (meta.name === 'compact') {
          void pi.compact(workspace);
          return;
        }
        if (meta.name === 'newSession' || meta.name === 'new') {
          void (async () => {
            await pi.newSession(workspace);
            store.reset();
            clear();
          })();
        }
        return;
      }

      // api 命令：触发 token 已被编辑器移除，这里插入一个紫色命令标签（发送时序列化为 /name）。
      editor.dispatchCommand(INSERT_CHAT_TAG_COMMAND, {
        category: 'command',
        label: String(option.label),
        value: meta.name,
        commandGroup: meta.group,
      });
    },
    [workspace, store, clear],
  );

  return { slashItems, onSelect };
}
