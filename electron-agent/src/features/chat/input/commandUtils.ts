import type { EditorSlashMenuItems, EditorSlashMenuOption } from '@lobehub/ui';
import type { CommandApiSource, PiCommand } from './commandTypes';

const GROUP_LABELS: Record<CommandApiSource | 'frontend', string> = {
  frontend: '快捷操作',
  builtin: '内置',
  extension: '扩展',
  prompt: '提示词',
  skill: '技能',
  unknown: '其他',
};

const GROUP_ORDER: Array<CommandApiSource | 'frontend'> = [
  'frontend',
  'extension',
  'prompt',
  'skill',
  'builtin',
  'unknown',
];

function normalizeApiSource(source: unknown): CommandApiSource {
  if (source === 'builtin' || source === 'extension' || source === 'prompt' || source === 'skill') {
    return source;
  }
  return 'unknown';
}

function normalizeApiCommand(raw: unknown): PiCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (!name) return null;

  const apiSource =
    item.apiSource !== undefined
      ? normalizeApiSource(item.apiSource)
      : item.source !== undefined
        ? normalizeApiSource(item.source)
        : 'unknown';

  const command: PiCommand = {
    name,
    description: typeof item.description === 'string' ? item.description : undefined,
    source: 'api',
    apiSource,
    category: typeof item.category === 'string' ? item.category : undefined,
  };
  if (item.requiresArgs === true) command.requiresArgs = true;
  if (item.dangerous === true) command.dangerous = true;
  return command;
}

/** Pi get_commands may return an array or `{ commands: [...] }`. */
export function parseCommands(raw: unknown): PiCommand[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === 'object' && 'commands' in raw) {
    const commands = (raw as { commands?: unknown }).commands;
    list = Array.isArray(commands) ? commands : [];
  }
  return list.map(normalizeApiCommand).filter((c): c is PiCommand => c !== null);
}

export function getFrontendCommands(): PiCommand[] {
  return [
    {
      name: 'compact',
      description: '压缩上下文',
      source: 'frontend',
    },
    {
      name: 'newSession',
      description: '新会话',
      source: 'frontend',
    },
  ];
}

export function mergeCommands(apiCommands: PiCommand[], frontendCommands: PiCommand[]): PiCommand[] {
  const frontendNames = new Set(frontendCommands.map((c) => c.name));
  frontendNames.add('new');

  const fromApi = apiCommands.filter(
    (command) => !(command.apiSource === 'builtin' && frontendNames.has(command.name)),
  );

  const apiNames = new Set(fromApi.map((c) => c.name));
  const fromFrontend = frontendCommands.filter((c) => !apiNames.has(c.name));

  return [...fromApi, ...fromFrontend].sort((a, b) => a.name.localeCompare(b.name));
}

export function slashMenuValue(command: PiCommand): string {
  if (command.source === 'frontend') return `frontend:${command.name}`;
  return `api:${command.name}`;
}

export function parseSlashMenuValue(value: string): { kind: 'frontend' | 'api'; name: string } | null {
  const idx = value.indexOf(':');
  if (idx <= 0) return null;
  const kind = value.slice(0, idx);
  const name = value.slice(idx + 1);
  if (!name) return null;
  if (kind === 'frontend' || kind === 'api') return { kind, name };
  return null;
}

function groupKey(command: PiCommand): CommandApiSource | 'frontend' {
  if (command.source === 'frontend') return 'frontend';
  return command.apiSource ?? 'unknown';
}

/**
 * Pi returns skill commands as `skill:<name>` and only expands `/skill:<name>` on execution.
 * Show the bare name for readability but keep the prefixed value so insertion still emits
 * `/skill:<name>`.
 */
function stripSkillPrefix(name: string): string {
  return name.startsWith('skill:') ? name.slice(6) : name;
}

/**
 * slash 菜单按「命令名前缀」匹配：用户输入 /xxx 只应出名字以 xxx 开头的命令。
 * 也匹配技能去掉 `skill:` 前缀后的展示名，使 /caveman 能命中 skill:caveman。
 * 刻意不匹配 description——否则会把名字非前缀、仅描述里含该词的命令也搜出来（用户反馈的噪音来源）。
 */
export function commandMatchesQuery(command: PiCommand, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const name = command.name.toLowerCase();
  if (name.startsWith(q)) return true;
  const display = stripSkillPrefix(command.name).toLowerCase();
  return display !== name && display.startsWith(q);
}

function toMenuOption(command: PiCommand): EditorSlashMenuOption {
  const displayName = command.apiSource === 'skill' ? stripSkillPrefix(command.name) : command.name;
  const keywords = [command.name, displayName, command.description].filter(Boolean) as string[];
  return {
    value: slashMenuValue(command),
    label: displayName,
    extra: command.description,
    keywords,
    danger: command.dangerous,
  };
}

export function toSlashMenuItems(commands: PiCommand[]): EditorSlashMenuItems {
  const buckets = new Map<CommandApiSource | 'frontend', EditorSlashMenuOption[]>();

  for (const command of commands) {
    const key = groupKey(command);
    const bucket = buckets.get(key) ?? [];
    bucket.push(toMenuOption(command));
    buckets.set(key, bucket);
  }

  const groups: EditorSlashMenuItems = [];
  for (const key of GROUP_ORDER) {
    const items = buckets.get(key);
    if (!items?.length) continue;
    groups.push({ label: GROUP_LABELS[key], items });
  }
  return groups;
}
