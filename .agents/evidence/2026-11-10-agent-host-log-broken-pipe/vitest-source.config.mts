import { fileURLToPath } from 'node:url';
import config from '../../../electron-agent/vitest.config.ts';

// 本工作区遗留的同目录 .js 会抢先于已修改的 .ts；只覆盖本次目标，不删除用户文件。
const source = fileURLToPath(new URL('../../../electron-agent/electron/agentProcess/agentProcessClient.ts', import.meta.url));
for (const project of config.test!.projects! as any[]) {
  if (project.test?.name === 'main') {
    project.resolve = { ...project.resolve, alias: [{ find: './agentProcessClient.js', replacement: source }] };
  }
}
export default config;
