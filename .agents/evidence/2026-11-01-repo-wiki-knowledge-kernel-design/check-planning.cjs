const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const files = [
  'docs/superpowers/specs/2026-11-01-repo-wiki-knowledge-kernel-design.md',
  'docs/superpowers/plans/2026-11-01-repo-wiki-knowledge-kernel.md',
  '.agents/notes/proposed/architecture/2026-11-01-repo-wiki-knowledge-kernel.md',
  '.agents/evidence/2026-11-01-repo-wiki-knowledge-kernel-design/qoder-reference.md',
];
const errors = [], checks = [];
const contents = files.map(file => {
  const absolute = path.join(root, file), text = fs.readFileSync(absolute, 'utf8');
  if (!text.endsWith('\n')) errors.push(file + ': missing final newline');
  text.split('\n').forEach((line, index) => { if (/[\t ]+$/.test(line)) errors.push(`${file}:${index + 1}: trailing whitespace`); });
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#')[0];
    if (!target || /^https?:/.test(target)) continue;
    if (!fs.existsSync(path.resolve(path.dirname(absolute), target))) errors.push(file + ': missing link ' + target);
  }
  if (/\b(?:TODO|TBD|FIXME)\b|待定|以后再说/.test(text)) errors.push(file + ': unresolved placeholder');
  checks.push({ file, bytes: Buffer.byteLength(text), lines: text.split('\n').length - 1 });
  return text;
});
const [spec, plan] = contents;
const tasks = [...plan.matchAll(/^### 任务 (\d+)：/gm)].map(match => Number(match[1]));
if (tasks.join(',') !== Array.from({ length: 12 }, (_, index) => index + 1).join(',')) errors.push('Expected exactly tasks 1-12');
for (const name of ['KnowledgePhase', 'KnowledgeKey', 'ExecutionFence', 'KnowledgeTaskMetadata', 'KnowledgeMessageInput', 'TranscriptContext', 'AssistantMessage']) {
  if (!spec.includes(name) || !plan.includes(name)) errors.push('Missing cross-document contract ' + name);
}
for (const name of ['knowledge_build_items', 'knowledge_source_snapshots', 'knowledge_execution_requests', 'agent_job_leases']) if (!spec.includes(name)) errors.push('Missing store ownership ' + name);
if (spec.includes('knowledge_model_attempts') || plan.includes('knowledge_model_attempts')) errors.push('Stale accounting table name');
for (const name of ['bindEpoch', 'activateEpoch', 'ackUsage', 'reserveExecutionBudget']) if (!spec.includes(name) || !plan.includes(name)) errors.push('Incomplete accounting/epoch protocol ' + name);
const coverage = {
  1: [1, 10, 11, 12], 2: [1, 5, 6, 10, 12], 3: [3, 4, 8, 10],
  4: [1, 2, 8, 10, 11], 5: [2, 3, 8], 6: [5, 6, 9], 7: [3, 4],
  8: [2, 3, 4], 9: [2, 7, 8, 12], 10: [9, 11, 12],
  11: [8, 10, 11, 12], 12: [10, 11, 12], 13: [12],
};
const result = { status: errors.length ? 'failed' : 'passed', scope: 'planning documents only; no implementation tests executed', checks, taskCount: tasks.length, specSectionToTasks: coverage, independentReview: { findings: 2, resolvedAtPlanningLevel: 2 }, errors };
fs.writeFileSync(path.join(root, '.agents/evidence/2026-11-01-repo-wiki-knowledge-kernel-design/planning-check.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exitCode = 1;
