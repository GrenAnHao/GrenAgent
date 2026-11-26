import { invoke } from '../platform/runtime';
import type { PromptParam } from '@extensions/prompt-commands/syntax';
import type { AgentMode } from '../stores/modeStore';

export interface PromptCommandInfo {
  name: string;
  description: string;
  body: string;
  params: PromptParam[];
  path: string;
  error?: string;
}

export type RuleScope = 'global' | 'project';

export interface RuleInfo {
  id: string;
  scope: RuleScope;
  path: string;
  title: string;
  enabled: boolean;
  body: string;
  /** 适用模式；缺省 = 所有模式。 */
  modes?: AgentMode[];
  globs?: string[];
  builtinProject?: string;
  currentProject?: boolean;
  readOnly?: boolean;
  error?: string;
}

export interface RuleRef {
  scope: RuleScope;
  id: string;
}

export function listPromptCommands(): Promise<PromptCommandInfo[]> {
  return invoke<PromptCommandInfo[]>('list_prompt_commands');
}

export function savePromptCommand(input: {
  originalName?: string;
  name: string;
  description: string;
  body: string;
  reserved: string[];
}): Promise<PromptCommandInfo> {
  return invoke<PromptCommandInfo>('save_prompt_command', input);
}

export function deletePromptCommand(name: string): Promise<void> {
  return invoke<void>('delete_prompt_command', { name });
}

export function listContextRules(workspace: string): Promise<RuleInfo[]> {
  return invoke<RuleInfo[]>('list_context_rules', { workspace });
}

export function saveContextRule(input: {
  workspace: string;
  scope: RuleScope;
  original?: RuleRef;
  title: string;
  enabled: boolean;
  body: string;
  modes?: AgentMode[];
  globs?: string[];
}): Promise<RuleInfo> {
  return invoke<RuleInfo>('save_context_rule', input);
}

export function setContextRuleEnabled(workspace: string, ref: RuleRef, enabled: boolean): Promise<void> {
  return invoke<void>('set_context_rule_enabled', { workspace, ...ref, enabled });
}

export function deleteContextRule(workspace: string, ref: RuleRef): Promise<void> {
  return invoke<void>('delete_context_rule', { workspace, ...ref });
}

export const extensionDirectory = (kind: 'commands' | 'rules', workspace = '', open = false) =>
  invoke<string>('extension_directory', { kind, workspace, open });
export const saveBuiltinRule = (workspace: string, path: string, original: string, content: string) =>
  invoke<void>('save_builtin_rule', { workspace, path, original, content });

export const openBuiltinDirectory = (workspace: string, path: string) =>
  invoke<string>('extension_directory', { kind: 'builtin-rule', workspace, path, open: true });
