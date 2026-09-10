import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { restartRuntimeConfig } from '../../../extensions/_shared/runtime-config.js';

/**
 * Q2-A：在任何 runInWorkspace() 之前调用一次。
 * 设 process.env.PI_RUNTIME_CONFIG，确保文件存在（fs.watch 对不存在路径抛错并被吞，
 * watcher 就再也建不起来），再 restartRuntimeConfig 让 watcher 在 ALS 之外创建。
 */
export function bootstrapRuntimeConfig(runtimeConfigPath: string): void {
  const dir = dirname(runtimeConfigPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(runtimeConfigPath)) writeFileSync(runtimeConfigPath, '{}');
  process.env.PI_RUNTIME_CONFIG = runtimeConfigPath;
  restartRuntimeConfig();
}
