import { invoke } from '../platform/runtime';
import type { PromptParam } from '@extensions/prompt-commands/syntax';

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
}): Promise<RuleInfo> {
  return invoke<RuleInfo>('save_context_rule', input);
}

export function setContextRuleEnabled(workspace: string, ref: RuleRef, enabled: boolean): Promise<void> {
  return invoke<void>('set_context_rule_enabled', { workspace, ...ref, enabled });
}

export function deleteContextRule(workspace: string, ref: RuleRef): Promise<void> {
  return invoke<void>('delete_context_rule', { workspace, ...ref });
}
