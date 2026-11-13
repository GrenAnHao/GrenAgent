const fs = require('node:fs');
const path = 'electron-agent/electron/agentData/jobStore.ts';
let source = fs.readFileSync(path, 'utf8');
const lines = source.split('\n');
let changed = 0;

// 逐行处理：只改代码行里的 SQL 表名，且保持原有引号种类，避免破坏内嵌单/双引号。
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (/^\s*(\*|\/\/)/.test(line)) continue;       // 注释
  if (line.includes('this.table')) continue;       // 已参数化
  if (!line.includes('agent_jobs')) continue;
  if (/this\.table = options\.table/.test(line)) continue;

  let out = line;
  // 单引号 SQL：内部不含单引号转义，安全换成模板字面量
  out = out.replace(/'([^']*?)agent_jobs([^']*?)'/g, (m, a, b) => '`' + a + '${this.table}' + b + '`');
  // 双引号 SQL：内部含 SQL 单引号，换模板后单引号原样保留
  out = out.replace(/"([^"]*?)agent_jobs([^"]*?)"/g, (m, a, b) => '`' + a + '${this.table}' + b + '`');

  if (out !== line) { lines[i] = out; changed++; }
}

fs.writeFileSync(path, lines.join('\n'));
const after = fs.readFileSync(path, 'utf8');
const remaining = after.split('\n')
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => l.includes('agent_jobs') && !/^\s*(\*|\/\/)/.test(l) && !l.includes('this.table'));
console.log('changed lines:', changed);
console.log('remaining non-comment:', remaining.map(([n]) => n).join(',') || 'none');
