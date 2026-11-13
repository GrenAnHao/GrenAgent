import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * agentdata-host 监听的命名管道 / Unix socket 路径。主进程启动时定一次，子进程崩溃重拉沿用同一个，
 * 扩展缓存的端点因此一直有效。含主进程 pid 与随机串，多开实例不冲突。
 * POSIX：放在新建的 0700 临时目录里（只有本用户能连），路径要短于 sun_path 上限（macOS 104 字节）。
 */
export function agentDataPipePath(platform: NodeJS.Platform = process.platform, pid = process.pid): string {
  const suffix = `${pid}-${randomBytes(6).toString('hex')}`;
  if (platform === 'win32') return `\\\\.\\pipe\\grenagent-agentdata-${suffix}`;
  const dir = mkdtempSync(join(tmpdir(), 'gren-ad-'));
  return join(dir, 's.sock');
}
