import type { PromptCommandInfo } from '../../../../lib/promptLibraryIo';
import type { PiCommand } from '../commandTypes';

function paramTemplate(name: string, templates: readonly PromptCommandInfo[]): PromptCommandInfo | undefined {
  return templates.find((template) => template.name === name && template.params.length > 0);
}

/** 带参数的模板只能放在整个输入开头；不在开头时菜单里不列它们。 */
export function filterPromptCommands(
  commands: PiCommand[],
  templates: readonly PromptCommandInfo[],
  atStart: boolean,
): PiCommand[] {
  if (atStart) return commands;
  return commands.filter((command) => command.apiSource !== 'prompt' || !paramTemplate(command.name, templates));
}

/** 只对提示词模板生效：同名的扩展命令、技能不出参数提示。 */
export function paramHint(command: PiCommand, templates: readonly PromptCommandInfo[]): string | undefined {
  if (command.apiSource !== 'prompt') return undefined;
  const template = paramTemplate(command.name, templates);
  return template ? template.params.map((param) => `{${param.name}}`).join(' ') : undefined;
}
