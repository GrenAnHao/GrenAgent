import { parseCommandToken } from './editor/commandPaste';

/**
 * 「执行性命令」白名单（保守）：发出后不产生对话轮次的纯动作命令。键统一小写。
 * 仅放确定项；不确定者（init/review/goal/deep-research 等）不放 → 默认保留气泡。
 */
export const EXECUTIVE_COMMANDS = new Set<string>([
  'compact', 'newsession', 'new',
  'dream', 'distill',
  'share', 'unshare', 'export', 'undo', 'redo',
  'model', 'models', 'theme', 'themes',
  'agent', 'agents', 'editor', 'mcp',
  'session', 'sessions', 'help', 'exit', 'quit',
]);

/** 命令名是否属于执行性命令（小写比较）。skill: 前缀命令必展开成提示词轮次，永不执行性。 */
export function isExecutiveCommand(name: string): boolean {
  if (name.startsWith('skill:')) return false;
  return EXECUTIVE_COMMANDS.has(name.toLowerCase());
}

/** 整条消息是否就是单个执行性命令（可带参数）→ 发送时不留气泡。 */
export function isExecutiveCommandMessage(text: string): boolean {
  const parsed = parseCommandToken(text);
  return parsed ? isExecutiveCommand(parsed.name) : false;
}
