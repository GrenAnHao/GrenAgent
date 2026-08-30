import {
  Bot,
  CircleHelp,
  Cpu,
  FileDown,
  FileSearch,
  FoldVertical,
  History,
  Link2Off,
  LogOut,
  MessageSquarePlus,
  MessageSquareText,
  Palette,
  PenLine,
  Plug,
  Redo2,
  Rocket,
  Share2,
  Sparkles,
  SquareTerminal,
  Target,
  Telescope,
  Undo2,
  Wand2,
  Wrench,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CommandApiSource, PiCommand } from './commandTypes';

/** Slash 菜单的命令类目：前端快捷操作 + Pi 上报的几种来源。 */
export type CommandGroupKey = CommandApiSource | 'frontend';

/**
 * 类目图标：让 skill / 系统命令 / 工具命令 等类目在视觉上各自可辨。
 * - 技能(skill)、工具(extension)、提示词(prompt) 等类目统一用各自的类目图标；
 * - 系统命令(builtin)、快捷操作(frontend) 仅作兜底，优先走下面的按功能图标。
 */
export const CATEGORY_ICON: Record<CommandGroupKey, LucideIcon> = {
  frontend: Zap,
  builtin: SquareTerminal,
  extension: Wrench,
  prompt: MessageSquareText,
  skill: Sparkles,
  unknown: Wand2,
};

/**
 * 系统命令（内置 / 快捷操作）按命令名匹配的专属图标——图标语义对应命令功能
 * （用户诉求：系统命令要用符合功能的图标）。命中优先于类目兜底，键统一用小写。
 * 仅覆盖系统命令；技能 / 工具 / 提示词等类目按类目图标统一展示，不在此细分。
 */
export const COMMAND_ICON: Record<string, LucideIcon> = {
  // 会话 / 上下文
  compact: FoldVertical,
  new: MessageSquarePlus,
  newsession: MessageSquarePlus,
  session: History,
  sessions: History,
  share: Share2,
  unshare: Link2Off,
  export: FileDown,
  undo: Undo2,
  redo: Redo2,
  // 配置 / 环境
  init: Rocket,
  model: Cpu,
  models: Cpu,
  agent: Bot,
  agents: Bot,
  editor: PenLine,
  theme: Palette,
  themes: Palette,
  mcp: Plug,
  help: CircleHelp,
  exit: LogOut,
  quit: LogOut,
  // 内置工作流类命令
  review: FileSearch,
  goal: Target,
  'deep-research': Telescope,
};

function categoryOf(command: PiCommand): CommandGroupKey {
  return command.source === 'frontend' ? 'frontend' : (command.apiSource ?? 'unknown');
}

/** Pi 把技能命令上报为 `skill:<name>`，匹配命令名时去掉前缀。 */
function bareName(name: string): string {
  return (name.startsWith('skill:') ? name.slice(6) : name).toLowerCase();
}

/**
 * 解析单条命令应展示的图标：
 * 1. 系统命令（内置 / 快捷操作）优先用按功能匹配的专属图标，未匹配回退到类目图标；
 * 2. 其余类目（技能 / 工具 / 提示词 / 其他）统一用各自的类目图标，保证类目整体可辨。
 */
export function resolveCommandIcon(command: PiCommand): LucideIcon {
  const category = categoryOf(command);
  if (category === 'builtin' || category === 'frontend') {
    return COMMAND_ICON[bareName(command.name)] ?? CATEGORY_ICON[category];
  }
  return CATEGORY_ICON[category];
}
