import { invoke } from '@tauri-apps/api/core';

export function codeIntelStatus(workspace: string): Promise<string> {
  return invoke<string>('code_intel_status', { workspace });
}

export function codeIntelInit(workspace: string): Promise<string> {
  return invoke<string>('code_intel_init', { workspace });
}

export function codeIntelSync(workspace: string): Promise<string> {
  return invoke<string>('code_intel_sync', { workspace });
}

export function codeIntelReindex(workspace: string): Promise<string> {
  return invoke<string>('code_intel_reindex', { workspace });
}

export function codeIntelIsInitialized(workspace: string): Promise<boolean> {
  return invoke<boolean>('code_intel_is_initialized', { workspace });
}
