// 真实 agent-data.db 的副本上启动修复后的 AgentDataRuntime（注册 codegraph.sync 执行器），看卡住的任务怎么落定。
// 用法（仓库根目录）：pnpm exec tsx .agents/evidence/2026-10-16-orphan-job-settle/real-db-run.mts <副本路径>
import { AgentDataRuntime } from '../../../electron-agent/electron/agentData/runtime';
const STUCK = 'c16b0249-a102-41dd-b4c4-ec96f871a851';
async function main() {
  const runtime = new AgentDataRuntime({ dataPath: process.argv[2], jobRunners: { 'codegraph.sync': { run: async () => {}, cancel: () => {} } } });
  await runtime.start();
  const page = await runtime.requestAdmin<{ items: Array<Record<string, unknown>>; activeCount: number }>('admin.tasks.list', { limit: 20 });
  const stuck = page.items.find((item) => (item.ref as { id: string }).id === STUCK);
  console.log(JSON.stringify({ activeCount: page.activeCount, stuck: stuck && { status: stuck.status, cancellationRequested: stuck.cancellationRequested, capabilities: stuck.capabilities, stage: stuck.stage, error: stuck.error } }, null, 2));
  runtime.close();
  process.exit(0);
}
void main();
