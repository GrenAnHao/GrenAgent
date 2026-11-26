/**
 * 临时生产数据的会话迁移 IPC 夹具（不接触真实会话 / 凭据 / 远程模型）。
 *
 * - agentDir / HOME / 两个项目 / 其他目标全部在 tmpdir 下；结束后整体删除。
 * - 会话文件用真实 Pi SDK SessionManager 写：多分支、标签、context edit、压缩、旧 working_directory、
 *   思考签名、用量、标题，主会话 catalog 声明一个 continuable 和一个 one-shot 子代理。
 * - 子会话 JSONL 带真实的 subagent_meta（含父路径 / parentSessionId / depth / mode / workspace）。
 * - 项目 `.pi/subagents/registry.db` 用与 SubAgentRegistry 相同的 schema 写入已结算行；
 *   同时塞入一份无关会话的登记，验证迁移只搬本族。
 * - 位置存储写 `<agentDir>/session-positions/<id>.json`，用于确认 leaf / null-root。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionManager } from '../../../cli/node_modules/@earendil-works/pi-coding-agent/dist/index.js';

function sessionDir(agentDir, name) {
  return join(agentDir, 'sessions', `--fixture-${name}--`);
}

function usage(input, output, cost) {
  return {
    input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
    cost: { input: cost, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

export async function createTransferFixture(root, agentDir) {
  const source = join(root, 'projects', 'source');
  const target = join(root, 'projects', 'target');
  const other = join(root, 'projects', 'other');
  const fourth = join(root, 'projects', 'fourth');
  for (const workspace of [source, target, other, fourth]) await mkdir(workspace, { recursive: true });
  await mkdir(join(agentDir, 'sessions'), { recursive: true });

  // 两个项目各自的项目说明、规则和同名文件：迁移后必须使用目标内容，不能沿用源项目。
  await writeFile(join(source, 'AGENTS.md'), 'SOURCE_AGENTS_ONLY\n');
  await writeFile(join(target, 'AGENTS.md'), 'TARGET_AGENTS_ONLY\n');
  await writeFile(join(other, 'AGENTS.md'), 'OTHER_AGENTS_ONLY\n');
  for (const workspace of [source, target, other]) await mkdir(join(workspace, '.pi', 'rules'), { recursive: true });
  await writeFile(join(source, '.pi', 'rules', 'source-rule.md'), '---\ntitle: source rule\nenabled: true\n---\nSOURCE_RULE_BODY\n');
  await writeFile(join(target, '.pi', 'rules', 'target-rule.md'), '---\ntitle: target rule\nenabled: true\n---\nTARGET_RULE_BODY\n');
  await writeFile(join(other, '.pi', 'rules', 'other-rule.md'), '---\ntitle: other rule\nenabled: true\n---\nOTHER_RULE_BODY\n');
  await writeFile(join(source, 'rules-probe.txt'), 'SOURCE_FILE_CONTENT\n');
  await writeFile(join(target, 'rules-probe.txt'), 'TARGET_FILE_CONTENT\n');
  await writeFile(join(other, 'rules-probe.txt'), 'OTHER_FILE_CONTENT\n');

  const dir = sessionDir(agentDir, 'main');
  const main = SessionManager.create(source, dir);
  const mainPath = main.getSessionFile();
  const mainId = main.getSessionId();

  const continuableId = 'sa-continuable';
  const oneShotId = 'sa-oneshot';
  const children = [];
  for (const [id, mode] of [[continuableId, 'continuable'], [oneShotId, 'one-shot']]) {
    const child = SessionManager.create(source, dir, { id, parentSession: mainPath });
    const childPath = child.getSessionFile();
    child.appendMessage({ role: 'user', content: `${mode} child initial task`, timestamp: 5 });
    child.appendMessage({
      role: 'assistant', content: [{ type: 'text', text: `${mode.toUpperCase()}_CHILD_INITIAL_REPLY` }],
      api: 'openai-completions', provider: 'fixture', model: 'fixture-model', responseModel: 'physical-fixture',
      responseId: `child-initial-${id}`, usage: usage(4, 2, 0.002), stopReason: 'stop', timestamp: 6,
    });
    child.appendCustomEntry('subagent_meta', {
      origin: 'subagent', agentId: id, parentSession: mainPath, parentSessionId: mainId,
      model: 'fixture/fixture-model', mode, label: `${mode} child`,
      inheritedEventCount: 0, depth: 1, backend: 'in-process', routingMode: 'ordinary', workspace: source,
    });
    children.push({ id, mode, path: childPath });
  }

  const m1 = main.appendMessage({ role: 'user', content: '源项目里的最初请求', timestamp: 1 });
  const a1 = main.appendMessage({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'signed thought', thinkingSignature: 'fixture-signature' },
      { type: 'text', text: 'A answer' },
      { type: 'toolCall', id: 'historic-read', name: 'read', arguments: { path: 'src/config.ts' } },
    ],
    api: 'openai-completions', provider: 'fixture', model: 'fixture-model', responseModel: 'physical-fixture',
    responseId: 'historic-1', usage: usage(10, 5, 0.015), stopReason: 'stop', timestamp: 2,
  });
  const tool = main.appendMessage({
    role: 'toolResult', toolCallId: 'historic-read', toolName: 'read',
    content: [{ type: 'text', text: 'historical tool body from source project' }],
    isError: false, timestamp: 3,
  });
  // 真实 spawn_agent 把 catalog 追加在当前 leaf 下，后续消息继续从它们往下长：
  // 因此最终确认位置（leaf）在 catalog 之后，foldCatalog 在活动分支上仍能看到两个子级。
  let leaf = tool;
  for (const child of children) {
    leaf = main.appendCustomEntry('subagent_catalog', {
      version: 0, childId: child.id, sessionPath: child.path, childCreatedAt: child.mode === 'continuable' ? 1 : 2,
      mode: child.mode, label: `${child.mode} child`,
    });
  }
  main.appendLabelChange(m1, 'bookmark');
  main.branch(m1);
  main.appendMessage({ role: 'user', content: 'SIDE_BRANCH_ONLY', timestamp: 4 });
  main.branch(leaf);
  leaf = main.appendCustomEntry('working_directory', { cwd: join(source, 'subdir') });
  leaf = main.appendContextEdit(m1, { content: '源项目最初请求（上下文替换）' });
  leaf = main.appendCompaction('historical compaction summary', a1, 100);
  leaf = main.appendSessionInfo('Transfer fixture title');
  leaf = main.appendCustomEntry('session-preferences', {
    model: { provider: 'fixture', id: 'fixture-model' },
    thinkingLevel: 'off', fastMode: false, mode: 'agent', approval: 'full', revision: 1,
  });
  const mainText = await readFile(mainPath, 'utf8');

  // 无关项目会话 + 登记：迁移只搬本族。
  const unrelated = SessionManager.create(source, dir);
  const unrelatedPath = unrelated.getSessionFile();
  unrelated.appendMessage({ role: 'user', content: 'unrelated source conversation', timestamp: 7 });

  await writeRegistry(source, [
    registryRow(continuableId, children[0].path, mainId, 1, 'continuable output', '{"type":"message"}\n'),
    registryRow(oneShotId, children[1].path, mainId, 1, 'one-shot output', null),
    registryRow('sa-unrelated', unrelatedPath, null, 0, 'unrelated output', null),
  ]);
  await writeRegistry(target, []);
  await writeRegistry(other, []);
  await writeRegistry(fourth, []);

  // null-root：物理条目存在，但用户确认位置在第一条之前。
  const nullDir = sessionDir(agentDir, 'nullroot');
  const nullRoot = SessionManager.create(source, nullDir);
  const nullPath = nullRoot.getSessionFile();
  const nullId = nullRoot.getSessionId();
  nullRoot.appendMessage({ role: 'user', content: 'null root original user', timestamp: 8 });
  nullRoot.appendMessage({
    role: 'assistant', content: [{ type: 'text', text: 'NULL_ROOT_ANSWER' }],
    api: 'openai-completions', provider: 'fixture', model: 'fixture-model', responseModel: 'physical-fixture',
    responseId: 'null-root-1', usage: usage(3, 2, 0.001), stopReason: 'stop', timestamp: 9,
  });

  await writePosition(agentDir, mainId, mainPath, leaf, 11);
  await writePosition(agentDir, nullId, nullPath, null, 2);

  return {
    source, target, other, fourth, agentDir, sessionDir: dir,
    main: { id: mainId, path: mainPath, leafId: leaf, text: mainText },
    nullRoot: { id: nullId, path: nullPath, leafId: null },
    children, unrelatedPath,
    continuable: children[0], oneShot: children[1],
  };
}

function registryRow(id, sessionPath, parentId, depth, output, transcript) {
  return {
    id, task: `task-${id}`, profile: null, model: 'fixture/fixture-model', thinkingLevel: 'off',
    status: 'done', output, error: null, exitCode: 0, transcript,
    sessionPath, parentId, depth, jobId: null, bashState: null,
    createdAt: 1000 + depth, updatedAt: 2000 + depth,
  };
}

async function writeRegistry(workspace, rows) {
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(workspace, '.pi', 'subagents', 'registry.db');
  await mkdir(join(workspace, '.pi', 'subagents'), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS subagents (
      id TEXT PRIMARY KEY, task TEXT NOT NULL, profile TEXT, model TEXT, thinkingLevel TEXT,
      status TEXT NOT NULL, output TEXT, error TEXT, exitCode INTEGER, transcript TEXT,
      sessionPath TEXT, parentId TEXT, depth INTEGER NOT NULL DEFAULT 0, jobId TEXT, bashState TEXT,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);`);
    const insert = db.prepare('INSERT OR REPLACE INTO subagents VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const row of rows) {
      insert.run(row.id, row.task, row.profile, row.model, row.thinkingLevel, row.status, row.output,
        row.error, row.exitCode, row.transcript, row.sessionPath, row.parentId, row.depth,
        row.jobId, row.bashState, row.createdAt, row.updatedAt);
    }
  } finally {
    db.close();
  }
}

async function writePosition(agentDir, sessionId, sessionPath, leafId, entryCount) {
  const dir = join(agentDir, 'session-positions');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${encodeURIComponent(sessionId)}.json`), JSON.stringify({
    version: 1, path: sessionPath, leafId, entryCount,
  }));
}

export async function readRegistryIds(workspace) {
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(workspace, '.pi', 'subagents', 'registry.db');
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db.prepare('SELECT id, sessionPath, parentId, status FROM subagents ORDER BY id').all().map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
