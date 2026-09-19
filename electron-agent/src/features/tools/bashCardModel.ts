import { getArgString } from './toolUtils';

const WORK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Collapsed bash row copy: what the command does, never the raw command line. */
export function bashRowSummary(args: unknown): string {
  const description = getArgString(args, 'description').trim();
  return description || '执行命令';
}

/** Prompt label for the expanded terminal card (last cwd segment, else `$`). */
export function terminalPromptLabel(cwd: string | undefined): string {
  if (!cwd) return '$';
  const trimmed = cwd.replace(/[/\\]+$/, '');
  const segment = trimmed.split(/[/\\]/).pop();
  if (!segment || WORK_ID.test(segment)) return '$';
  return segment;
}

/** One prompt row per command line; a trailing newline is a terminator. */
export function terminalCommandLines(command: string): string[] {
  const body = command.endsWith('\n') ? command.slice(0, -1) : command;
  return body.length === 0 ? [''] : body.split('\n');
}

export function terminalOutputEmpty(output: string | undefined): boolean {
  return !output || output.trim() === '';
}
