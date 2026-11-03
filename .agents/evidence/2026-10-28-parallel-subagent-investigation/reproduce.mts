import assert from 'node:assert/strict';
import { argsLookParallel, expandSubAgents, subAgentMode } from '../../../electron-agent/src/features/panels/subagentUtils.ts';
import { normalizeTasks, spawnHasWork } from '../../../extensions/multi-agent/tasks.ts';

// 从仓库根目录运行；只调用实际纯函数，不启动子代理、不访问供应商、不改设置。
// node node_modules/tsx/dist/cli.mjs --tsconfig electron-agent/tsconfig.json .agents/evidence/2026-10-28-parallel-subagent-investigation/reproduce.mts
// 这里的断言确认“当前缺陷可重现”，不表示修复验收通过。修复后前两例应改为 1 行。
const cases = [
  { label: '现场形状，成功回执', args: { action: 'spawn', task: '只回复 OK', tasks: [], chain: [] }, status: 'done', result: { details: { agentId: 'sa-example', status: 'running', sessionPath: '/example.jsonl' } }, expectedRows: 0 },
  { label: '现场形状，禁用错误', args: { action: 'spawn', task: '只回复 OK', tasks: [], chain: [] }, status: 'error', result: { isError: true, content: [{ type: 'text', text: '子代理已被禁用' }] }, expectedRows: 0 },
  { label: '去掉空数组的单任务', args: { action: 'spawn', task: '只回复 OK' }, status: 'done', result: { details: { agentId: 'sa-example', status: 'running', sessionPath: '/example.jsonl' } }, expectedRows: 1 },
  { label: '真实并行两个任务', args: { action: 'run', tasks: ['只回复 A', '只回复 B'] }, status: 'running', result: {}, expectedRows: 2 },
  { label: '混用 task 与 tasks', args: { action: 'run', task: '顶层任务', tasks: ['数组任务'] }, status: 'running', result: {}, expectedRows: 1 },
] as const;
for (const c of cases) {
  const args = c.args;
  const grouped = argsLookParallel(args);
  const units = expandSubAgents('example', args, c.result, c.status, grouped);
  assert.equal(units.length, c.expectedRows, c.label);
  console.log(JSON.stringify({ case: c.label, backendWorkCount: normalizeTasks(args).length, backendHasWork: spawnHasWork(args), frontendGroup: grouped, frontendMode: subAgentMode(args), frontendUnitCount: units.length, frontendRows: units.map(u => ({ task: u.task, status: u.status })) }));
}
console.log('Confirmed: both successful and rejected single-task calls with tasks:[] produce zero display rows in current code.');
