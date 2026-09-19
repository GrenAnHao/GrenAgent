# Pi Package 扩展面板与官方市场 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 侧栏「扩展」模块把 MCP tab 正名为 MCP；新增「扩展」tab 管理官方 Pi Package；市场模态用 npm `keywords:pi-package` 检索，经 `DefaultPackageManager.installAndPersist` 安装，空闲后 `session.reload()` 动态载入。

**架构：** 纯函数放 `piPackageModel.ts`（净化查询、身份、enabled、搜索映射）。`PiPackageService` 按 scope 读写 `SettingsManager.getGlobalSettings().packages` / `getProjectSettings().packages`，禁止用合并视图 `getPackages()` 再 `setPackages()`。内置列表复用 `filterManagedExtensions(filterExtensionsByProfile(manifestExtensions, profile), allowedJson)`，禁止 `selectAllowedExtensions()`。IPC `package_*` 注入主进程；渲染层 `PiPackagesPanel` + `PackageMarketplaceModal`。安装确认用独立小模态，不用 `Modal.confirm`。

**技术栈：** TypeScript、vitest、Electron IPC、`@earendil-works/pi-coding-agent@0.85.1` 的 `SettingsManager` / `DefaultPackageManager`、`@lobehub/ui` Modal/Button/Switch、lucide + `Icon`。

**上游规格：** `docs/superpowers/specs/2026-09-16-pi-package-marketplace-design.md`（含 §0 审查表 M1–M5 / S1–S5）。**按修正后的规格实现，不要按审查前的草稿。**

---

## 动工前必读

- **不要隔离 worktree**，在当前仓库原地做。工作区很脏：每个任务 `git add` **只加本任务列出的文件**，禁止 `git add -A`。
- **按编号顺序执行，不要跳序。**
- Windows 提交用 PowerShell here-string，不要 bash `EOF` heredoc。
- 禁止 emoji。UI 图标一律 `@lobehub/ui` 的 `Icon` + `lucide-react`。
- **用户未明确要求提交时，跳过每个任务的 Commit 步骤**，把变更留在工作区。
- **不要改** PluginManager 白名单、`cli/src/extension-profile.ts` 的 filter 逻辑、MCP / 技能行为（除顶栏改名与加 tab）、`docs/pi/packages.md`、Chord 实验 Plugin、git / 本地路径安装。
- **禁止** 用 `selectAllowedExtensions()` 生成本地内置列表（它不含 `CORE_ALWAYS_ON`，只会剩 6 项）。
- **禁止** `setEnabled` 读 `getPackages()` 再 `setPackages()`（会把项目包复制进用户 `settings.json`）。
- `agentDir` 从 `main.ts:89` 注入：`process.env.PI_CODING_AGENT_DIR || join(app.getPath('home'), '.pi', 'agent')`。不要从 `SettingsService` 取。
- 渲染进程禁止 `fetch` npm registry。搜索只走主进程。
- `package_list` 的 `workspace` 允许空串（未打开项目）。不要用 `readString`（它拒绝空串）。
- 测试：electron 主进程用例跑 `electron-agent` 的 vitest **main** project；渲染层跑 **renderer** project（jsdom 已在 `vitest.config.ts` 里设好，不必再写 `@vitest-environment jsdom`）。

**测试命令：**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run <本任务列出的测试>
```

**提交（仅当用户要求时）：**

```powershell
git add <本任务文件>
git commit -m @"
feat(packages): <本任务一句话>

"@
```

---

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `electron-agent/electron/app/piPackageModel.ts` | 纯函数：查询净化、npm 身份、enabled 推导、搜索 DTO、testid 转义。无 Node/Electron API |
| `electron-agent/electron/app/piPackageModel.test.ts` | 上述纯函数 |
| `electron-agent/electron/app/piPackageService.ts` | 主进程：list / search / install / remove / setEnabled；调用 `requestResourceReload()` |
| `electron-agent/electron/app/piPackageService.test.ts` | mock fetch 与 PackageManager；M2 跨 scope 防回归 |
| `electron-agent/src/features/extensions/PiPackagesPanel.tsx` | 扩展 tab：内置只读行 + 市场包开关 / 卸载 + 「浏览市场」 |
| `electron-agent/src/features/extensions/PiPackagesPanel.test.tsx` | 列表、内置无开关、卸载确认 |
| `electron-agent/src/features/extensions/PackageMarketplaceModal.tsx` | 市场搜索、范围、独立安装确认 |
| `electron-agent/src/features/extensions/PackageMarketplaceModal.test.tsx` | 搜索、确认取消不 install、总数文案 |

修改：

| 文件 | 职责 |
| --- | --- |
| `cli/src/pi-sdk.ts` | 再导出 `DefaultPackageManager` 与 `PackageSource`，主进程不直接从 npm 包取值 |
| `electron-agent/electron/ipc/register.ts` | `IpcServices.piPackages`；注册 `package_*` |
| `electron-agent/electron/ipc/register.test.ts` | 路由 `package_*` 到服务方法 |
| `electron-agent/electron/main.ts` | `plugins.startAll()` 之后构造 `PiPackageService` 并注入 |
| `electron-agent/src/lib/pi.ts` | `packageList` / `packageSearch` / `packageInstall` / `packageRemove` / `packageSetEnabled` |
| `electron-agent/src/features/extensions/ExtensionsPanel.tsx` | tab 类型 `'mcp' \| 'packages' \| 'skills'`；MCP 文案/图标；扩展分支 |
| `electron-agent/src/features/extensions/ExtensionsPanel.test.tsx` | 三个 tab；MCP 文本；无 code-intel |
| `docs/architecture.md` | 「extensions —— 内置扩展包」补一句桌面端经 `PiPackageService` 管理 packages |

---

### 任务 1：`piPackageModel` 纯函数

**文件：**
- 创建：`electron-agent/electron/app/piPackageModel.ts`
- 测试：`electron-agent/electron/app/piPackageModel.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import {
  isPackageEnabled,
  isValidNpmName,
  isValidSemver,
  mapNpmSearchPayload,
  npmNameFromSource,
  packageIdentity,
  packageRowTestId,
  packageSourceString,
  pinNpmSource,
  replacePackageEntry,
  sanitizeSearchQuery,
  truncateError,
  withAutoload,
  type PackageSource,
} from './piPackageModel';

describe('sanitizeSearchQuery', () => {
  it('strips colons and quotes so npm qualifiers cannot be injected', () => {
    expect(sanitizeSearchQuery('foo:bar author:evil "x"')).toBe('foo bar author evil x');
  });

  it('keeps letters, digits, scope slashes and dots', () => {
    expect(sanitizeSearchQuery('  @scope/pi-tools.v2  ')).toBe('@scope/pi-tools.v2');
  });
});

describe('package identity', () => {
  it('ignores npm version refs, including scoped names', () => {
    expect(packageIdentity('npm:@foo/bar@1.2.3')).toBe('npm:@foo/bar');
    expect(packageIdentity('npm:left-pad@1.0.0')).toBe('npm:left-pad');
    expect(npmNameFromSource('npm:@foo/bar@1.2.3')).toBe('@foo/bar');
  });

  it('leaves git and path sources untouched', () => {
    expect(packageIdentity('git:github.com/a/b')).toBe('git:github.com/a/b');
    expect(packageIdentity('./local-ext')).toBe('./local-ext');
  });
});

describe('enabled derivation', () => {
  it('treats string entries as enabled and autoload false as disabled', () => {
    expect(isPackageEnabled('npm:foo')).toBe(true);
    expect(isPackageEnabled({ source: 'npm:foo', autoload: true })).toBe(true);
    expect(isPackageEnabled({ source: 'npm:foo', autoload: false })).toBe(false);
    expect(isPackageEnabled({ source: 'npm:foo' })).toBe(true);
  });

  it('does not infer enabled from object-ness (filtered is not autoload)', () => {
    const objectForm: PackageSource = { source: 'npm:foo', autoload: true, skills: ['a'] };
    expect(isPackageEnabled(objectForm)).toBe(true);
  });
});

describe('withAutoload', () => {
  it('writes string form when enabling an entry with no resource filters', () => {
    expect(withAutoload({ source: 'npm:foo', autoload: false }, true)).toBe('npm:foo');
    expect(withAutoload('npm:foo@1.0.0', true)).toBe('npm:foo@1.0.0');
  });

  it('keeps skills/extensions filters when toggling', () => {
    const entry: PackageSource = { source: 'npm:foo@1.0.0', autoload: true, skills: ['x'], extensions: ['y'] };
    expect(withAutoload(entry, false)).toEqual({
      source: 'npm:foo@1.0.0',
      autoload: false,
      skills: ['x'],
      extensions: ['y'],
    });
    expect(withAutoload({ source: 'npm:foo', autoload: false, skills: ['x'] }, true)).toEqual({
      source: 'npm:foo',
      autoload: true,
      skills: ['x'],
    });
  });
});

describe('replacePackageEntry', () => {
  it('matches by identity ignoring version', () => {
    const next = replacePackageEntry(
      ['npm:foo@1.0.0', 'npm:bar'],
      'npm:foo@9.9.9',
      { source: 'npm:foo@1.0.0', autoload: false },
    );
    expect(next).toEqual([{ source: 'npm:foo@1.0.0', autoload: false }, 'npm:bar']);
  });
});

describe('search mapping and validation', () => {
  it('maps registry objects and defaults missing publisher', () => {
    const mapped = mapNpmSearchPayload({
      total: 9908,
      objects: [
        { package: { name: '@acme/pi-tool', version: '1.2.3', description: 'hi', publisher: { username: 'ada' } } },
        { package: { name: 'bare', version: '0.1.0' } },
      ],
    });
    expect(mapped.total).toBe(9908);
    expect(mapped.objects[0]).toEqual({
      name: '@acme/pi-tool',
      version: '1.2.3',
      description: 'hi',
      publisher: 'ada',
      npmUrl: 'https://www.npmjs.com/package/@acme/pi-tool',
    });
    expect(mapped.objects[1].publisher).toBe('');
    expect(mapped.objects[1].description).toBe('');
  });

  it('accepts npm names and semver, rejects garbage', () => {
    expect(isValidNpmName('@foo/bar')).toBe(true);
    expect(isValidNpmName('UPPER')).toBe(false);
    expect(isValidSemver('1.2.3-beta.1')).toBe(true);
    expect(isValidSemver('latest')).toBe(false);
    expect(pinNpmSource('@foo/bar', '1.2.3')).toBe('npm:@foo/bar@1.2.3');
  });

  it('escapes row test ids and truncates errors to 300 chars', () => {
    expect(packageRowTestId('package', 'npm:@foo/bar@1.0.0')).toBe('package-row-npm-foo-bar-1.0.0');
    expect(packageRowTestId('builtin', 'todo')).toBe('package-row-builtin-todo');
    expect(truncateError('x'.repeat(400)).length).toBe(300);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/piPackageModel.test.ts
```

预期：FAIL，找不到 `./piPackageModel`。

- [ ] **步骤 3：编写最少实现代码**

```ts
export type PackageSource = string | {
  source: string;
  autoload?: boolean;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
};

export type PackageScope = 'product' | 'user' | 'project';

export interface PackageListItem {
  kind: 'builtin' | 'package';
  id: string;
  title: string;
  scope: PackageScope;
  enabled: boolean;
  canDisable: boolean;
  canRemove: boolean;
}

export interface MarketplaceHit {
  name: string;
  version: string;
  description: string;
  publisher: string;
  npmUrl: string;
}

export interface PackageSearchResult {
  objects: MarketplaceHit[];
  total: number;
}

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function sanitizeSearchQuery(input: string): string {
  return input.replace(/[^\p{L}\p{N}\s@/._-]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function packageSourceString(entry: PackageSource): string {
  return typeof entry === 'string' ? entry : entry.source;
}

function stripNpmVersion(spec: string): string {
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash < 0) return spec;
    const rest = spec.slice(slash + 1);
    const at = rest.lastIndexOf('@');
    if (at <= 0) return spec;
    return spec.slice(0, slash + 1 + at);
  }
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

export function packageIdentity(source: string): string {
  if (
    source.startsWith('git:')
    || source.startsWith('https:')
    || source.startsWith('ssh:')
    || source.startsWith('file:')
    || source.startsWith('.')
    || source.startsWith('/')
  ) {
    return source;
  }
  const spec = source.startsWith('npm:') ? source.slice(4) : source;
  return `npm:${stripNpmVersion(spec)}`;
}

export function npmNameFromSource(source: string): string {
  const spec = source.startsWith('npm:') ? source.slice(4) : source;
  return stripNpmVersion(spec);
}

export function isPackageEnabled(entry: PackageSource): boolean {
  return typeof entry === 'string' ? true : entry.autoload !== false;
}

function resourceFilters(entry: Extract<PackageSource, object>): Pick<Extract<PackageSource, object>, 'extensions' | 'skills' | 'prompts' | 'themes'> {
  return {
    ...(entry.extensions ? { extensions: entry.extensions } : {}),
    ...(entry.skills ? { skills: entry.skills } : {}),
    ...(entry.prompts ? { prompts: entry.prompts } : {}),
    ...(entry.themes ? { themes: entry.themes } : {}),
  };
}

export function withAutoload(entry: PackageSource, enabled: boolean): PackageSource {
  const source = packageSourceString(entry);
  if (typeof entry === 'object') {
    const filters = resourceFilters(entry);
    if (enabled && Object.keys(filters).length === 0) return source;
    return { source, autoload: enabled, ...filters };
  }
  return enabled ? source : { source, autoload: false };
}

export function replacePackageEntry(packages: PackageSource[], source: string, next: PackageSource): PackageSource[] {
  const identity = packageIdentity(source);
  let found = false;
  const result = packages.map((entry) => {
    if (packageIdentity(packageSourceString(entry)) !== identity) return entry;
    found = true;
    return next;
  });
  if (!found) throw new Error('PACKAGE_NOT_FOUND');
  return result;
}

export function isValidNpmName(name: string): boolean {
  return NPM_NAME.test(name);
}

export function isValidSemver(version: string): boolean {
  return SEMVER.test(version);
}

export function pinNpmSource(name: string, version: string): string {
  return `npm:${name}@${version}`;
}

export function mapNpmSearchPayload(json: unknown): PackageSearchResult {
  if (!json || typeof json !== 'object') throw new Error('invalid npm search payload');
  const root = json as { total?: unknown; objects?: unknown };
  const rawObjects = Array.isArray(root.objects) ? root.objects : [];
  const objects: MarketplaceHit[] = [];
  for (const item of rawObjects) {
    const pkg = item && typeof item === 'object' ? (item as { package?: unknown }).package : undefined;
    if (!pkg || typeof pkg !== 'object') continue;
    const record = pkg as {
      name?: unknown;
      version?: unknown;
      description?: unknown;
      publisher?: { username?: unknown };
    };
    if (typeof record.name !== 'string' || typeof record.version !== 'string') continue;
    objects.push({
      name: record.name,
      version: record.version,
      description: typeof record.description === 'string' ? record.description : '',
      publisher: typeof record.publisher?.username === 'string' ? record.publisher.username : '',
      npmUrl: `https://www.npmjs.com/package/${record.name}`,
    });
  }
  const total = typeof root.total === 'number' && Number.isFinite(root.total) ? root.total : objects.length;
  return { objects, total };
}

export function packageRowTestId(kind: 'builtin' | 'package', id: string): string {
  if (kind === 'builtin') return `package-row-builtin-${id}`;
  return `package-row-${id.replace(/[^a-zA-Z0-9._-]+/g, '-')}`;
}

export function truncateError(message: string): string {
  return message.length <= 300 ? message : message.slice(0, 300);
}

export function findRawEntry(packages: PackageSource[] | undefined, source: string): PackageSource | undefined {
  const identity = packageIdentity(source);
  return (packages ?? []).find((entry) => packageIdentity(packageSourceString(entry)) === identity);
}
```

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/piPackageModel.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/electron/app/piPackageModel.ts electron-agent/electron/app/piPackageModel.test.ts
git commit -m @"
feat(packages): add Pi package identity and search mapping helpers

"@
```

---

### 任务 2：`PiPackageService.search`

**文件：**
- 创建：`electron-agent/electron/app/piPackageService.ts`
- 测试：`electron-agent/electron/app/piPackageService.test.ts`

本任务只实现 `search`。`list` / `install` / `setEnabled` 在后续任务加。先把类骨架写到能跑 search。

- [ ] **步骤 1：编写失败的测试**

在 `piPackageService.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiPackageService } from './piPackageService';

afterEach(() => {
  vi.unstubAllGlobals();
});

function service(fetchImpl: typeof fetch) {
  return new PiPackageService({
    agentDir: 'C:/tmp/agent',
    allowedPluginIds: () => [],
    fetchImpl,
  });
}

describe('PiPackageService.search', () => {
  it('queries keywords:pi-package, size 20, no from, and maps hits', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url.startsWith('https://registry.npmjs.org/-/v1/search?')).toBe(true);
      const parsed = new URL(url);
      expect(parsed.searchParams.get('text')).toBe('keywords:pi-package demo');
      expect(parsed.searchParams.get('size')).toBe('20');
      expect(parsed.searchParams.get('from')).toBeNull();
      return new Response(JSON.stringify({
        total: 9908,
        objects: [{ package: { name: 'pi-demo', version: '2.0.0', description: 'd', publisher: { username: 'ada' } } }],
      }), { status: 200 });
    });
    const result = await service(fetchImpl).search('demo');
    expect(result.total).toBe(9908);
    expect(result.objects[0]?.name).toBe('pi-demo');
  });

  it('sanitizes colons out of the user query before calling npm', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).searchParams.get('text')).toBe('keywords:pi-package foo bar');
      return new Response(JSON.stringify({ total: 0, objects: [] }), { status: 200 });
    });
    await service(fetchImpl).search('foo:bar');
  });

  it('uses keywords:pi-package alone when the query is empty', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).searchParams.get('text')).toBe('keywords:pi-package');
      return new Response(JSON.stringify({ total: 1, objects: [] }), { status: 200 });
    });
    await service(fetchImpl).search('   ');
  });

  it('throws a short message when the registry is not ok', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
    await expect(service(fetchImpl).search('x')).rejects.toThrow(/HTTP 503/);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/piPackageService.test.ts
```

预期：FAIL，找不到 `PiPackageService`。

- [ ] **步骤 3：编写最少实现代码**

`piPackageService.ts` 本步只需 search。把 options 接口一次写全，后面任务往类上加方法，不要改字段名。

```ts
import { DefaultPackageManager, SettingsManager, type PackageSource } from '../../../cli/src/pi-sdk.js';
import { manifestExtensions } from '../../../extensions/index.js';
import { filterExtensionsByProfile, filterManagedExtensions, type ExtensionProfile } from '../../../cli/src/extension-profile.js';
import { requestResourceReload } from '../../../extensions/_shared/resource-reload.js';
import {
  findRawEntry,
  isPackageEnabled,
  isValidNpmName,
  isValidSemver,
  mapNpmSearchPayload,
  npmNameFromSource,
  packageSourceString,
  pinNpmSource,
  replacePackageEntry,
  sanitizeSearchQuery,
  withAutoload,
  type PackageListItem,
  type PackageSearchResult,
} from './piPackageModel';

export interface SettingsPort {
  getGlobalSettings(): { packages?: PackageSource[] };
  getProjectSettings(): { packages?: PackageSource[] };
  setPackages(packages: PackageSource[]): void;
  setProjectPackages(packages: PackageSource[]): void;
}

export interface PackageManagerPort {
  listConfiguredPackages(): Array<{ source: string; scope: 'user' | 'project'; filtered: boolean }>;
  installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
  removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
}

export interface PiPackageServiceOptions {
  agentDir: string;
  allowedPluginIds: () => string[];
  extensions?: Array<{ name: string; manifest?: { id: string } }>;
  profile?: ExtensionProfile;
  createSettingsManager?: (cwd: string, agentDir: string) => SettingsPort;
  createPackageManager?: (input: { cwd: string; agentDir: string; settingsManager: SettingsPort }) => PackageManagerPort;
  fetchImpl?: typeof fetch;
  requestReload?: () => boolean;
}

export class PiPackageService {
  private readonly agentDir: string;
  private readonly allowedPluginIds: () => string[];
  private readonly extensions: Array<{ name: string; manifest?: { id: string } }>;
  private readonly profile: ExtensionProfile;
  private readonly createSettingsManager: (cwd: string, agentDir: string) => SettingsPort;
  private readonly createPackageManager: (input: { cwd: string; agentDir: string; settingsManager: SettingsPort }) => PackageManagerPort;
  private readonly fetchImpl: typeof fetch;
  private readonly requestReload: () => boolean;

  constructor(options: PiPackageServiceOptions) {
    this.agentDir = options.agentDir;
    this.allowedPluginIds = options.allowedPluginIds;
    this.extensions = options.extensions ?? manifestExtensions;
    this.profile = options.profile ?? 'project';
    this.createSettingsManager = options.createSettingsManager
      ?? ((cwd, agentDir) => SettingsManager.create(cwd, agentDir));
    this.createPackageManager = options.createPackageManager
      ?? ((input) => new DefaultPackageManager(input as { cwd: string; agentDir: string; settingsManager: SettingsManager }));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestReload = options.requestReload ?? requestResourceReload;
  }

  async search(query: string): Promise<PackageSearchResult> {
    const cleaned = sanitizeSearchQuery(query);
    const text = cleaned ? `keywords:pi-package ${cleaned}` : 'keywords:pi-package';
    const url = `https://registry.npmjs.org/-/v1/search?${new URLSearchParams({ text, size: '20' })}`;
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return mapNpmSearchPayload(await response.json());
  }
}
```

同时改 `cli/src/pi-sdk.ts`，在现有 value export 里加上 `DefaultPackageManager`，在 type export 里加上 `PackageSource`：

```ts
export {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ModelRegistry,
  DefaultPackageManager,
  createAgentSessionRuntime,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

export type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionRuntime,
  ExtensionUIContext,
  JsonAgentSessionEvent,
  PackageSource,
  PromptOptions,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
```

主进程必须走 `cli/src/pi-sdk.js`，不要从 `@earendil-works/pi-coding-agent` 直接 import（见该文件头注释）。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/piPackageService.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add cli/src/pi-sdk.ts electron-agent/electron/app/piPackageService.ts electron-agent/electron/app/piPackageService.test.ts
git commit -m @"
feat(packages): search npm keywords:pi-package from the main process

"@
```

---

### 任务 3：`PiPackageService.list`（M1 / M3）

**文件：**
- 修改：`electron-agent/electron/app/piPackageService.ts`
- 测试：`electron-agent/electron/app/piPackageService.test.ts`

- [ ] **步骤 1：追加失败测试**

接到同一 `describe` 文件：

```ts
function fakeSettings(init: { global?: PackageSource[]; project?: PackageSource[] }) {
  let globalPkgs = [...(init.global ?? [])];
  let projectPkgs = [...(init.project ?? [])];
  return {
    getGlobalSettings: () => ({ packages: globalPkgs }),
    getProjectSettings: () => ({ packages: projectPkgs }),
    setPackages: vi.fn((next: PackageSource[]) => { globalPkgs = next; }),
    setProjectPackages: vi.fn((next: PackageSource[]) => { projectPkgs = next; }),
    getPackages: vi.fn(() => [...projectPkgs, ...globalPkgs]),
    snapshot: () => ({ globalPkgs, projectPkgs }),
  };
}

function fakeManager(list: Array<{ source: string; scope: 'user' | 'project'; filtered: boolean }>) {
  return {
    listConfiguredPackages: () => list,
    installAndPersist: vi.fn(async () => {}),
    removeAndPersist: vi.fn(async () => true),
  };
}

const builtins = [
  { name: 'safety' },
  { name: 'todo' },
  { name: 'lsp' },
  { name: 'goal', manifest: { id: 'goal' } },
  { name: 'code-exec' },
];

describe('PiPackageService.list', () => {
  it('lists CORE_ALWAYS_ON plus allowed managed plugins, not CHAT_EXCLUDED unmanaged names', async () => {
    const settings = fakeSettings({
      global: ['npm:user-pkg@1.0.0', { source: 'npm:off-pkg@2.0.0', autoload: false }],
      project: ['npm:proj-pkg@3.0.0'],
    });
    const svc = new PiPackageService({
      agentDir: 'C:/tmp/agent',
      allowedPluginIds: () => ['goal'],
      extensions: builtins,
      profile: 'project',
      createSettingsManager: () => settings,
      createPackageManager: () => fakeManager([
        { source: 'npm:user-pkg@1.0.0', scope: 'user', filtered: false },
        { source: 'npm:off-pkg@2.0.0', scope: 'user', filtered: true },
        { source: 'npm:proj-pkg@3.0.0', scope: 'project', filtered: false },
      ]),
    });
    const items = await svc.list('C:/ws');
    const builtinIds = items.filter((item) => item.kind === 'builtin').map((item) => item.id);
    expect(builtinIds).toEqual(['safety', 'todo', 'goal']);
    expect(builtinIds).not.toContain('lsp');
    expect(builtinIds).not.toContain('code-exec');
    const off = items.find((item) => item.id === 'npm:off-pkg@2.0.0');
    expect(off?.enabled).toBe(false);
    expect(off?.canDisable).toBe(true);
    const user = items.find((item) => item.id === 'npm:user-pkg@1.0.0');
    expect(user?.enabled).toBe(true);
    expect(user?.title).toBe('user-pkg');
    expect(items.find((item) => item.id === 'safety')?.canDisable).toBe(false);
  });

  it('hides project packages when no workspace is open', async () => {
    const svc = new PiPackageService({
      agentDir: 'C:/tmp/agent',
      allowedPluginIds: () => [],
      extensions: [{ name: 'safety' }],
      createSettingsManager: () => fakeSettings({
        global: ['npm:user-pkg'],
        project: ['npm:proj-pkg'],
      }),
      createPackageManager: () => fakeManager([
        { source: 'npm:user-pkg', scope: 'user', filtered: false },
        { source: 'npm:proj-pkg', scope: 'project', filtered: false },
      ]),
    });
    const items = await svc.list('');
    expect(items.some((item) => item.id === 'npm:proj-pkg')).toBe(false);
    expect(items.some((item) => item.id === 'npm:user-pkg')).toBe(true);
  });
});
```

把 `PackageSource` 从 `./piPackageModel` 引进测试文件。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/piPackageService.test.ts
```

预期：FAIL，`list` is not a function。

- [ ] **步骤 3：实现 `list`**

加到 `PiPackageService`：

```ts
  async list(workspace: string): Promise<PackageListItem[]> {
    const loaded = filterManagedExtensions(
      filterExtensionsByProfile(this.extensions, this.profile),
      JSON.stringify(this.allowedPluginIds()),
    );
    const builtins: PackageListItem[] = loaded.map((entry) => ({
      kind: 'builtin',
      id: entry.name,
      title: entry.name,
      scope: 'product',
      enabled: true,
      canDisable: false,
      canRemove: false,
    }));
    const { settings, packages } = this.open(workspace);
    const configured = packages.listConfiguredPackages()
      .filter((entry) => workspace.trim() || entry.scope === 'user');
    const mapped: PackageListItem[] = configured.map((entry) => {
      const raw = findRawEntry(
        entry.scope === 'project' ? settings.getProjectSettings().packages : settings.getGlobalSettings().packages,
        entry.source,
      );
      return {
        kind: 'package',
        id: entry.source,
        title: npmNameFromSource(entry.source),
        scope: entry.scope,
        enabled: raw ? isPackageEnabled(raw) : true,
        canDisable: true,
        canRemove: true,
      };
    });
    return [...builtins, ...mapped];
  }

  private open(workspace: string): { cwd: string; settings: SettingsPort; packages: PackageManagerPort } {
    const cwd = workspace.trim() || this.agentDir;
    const settings = this.createSettingsManager(cwd, this.agentDir);
    const packages = this.createPackageManager({ cwd, agentDir: this.agentDir, settingsManager: settings });
    return { cwd, settings, packages };
  }

  private assertProjectWorkspace(workspace: string, scope: 'user' | 'project'): void {
    if (scope === 'project' && !workspace.trim()) throw new Error('请先打开项目');
  }
```

`enabled` **必须**来自原始 `PackageSource`（string → true，object → `autoload !== false`）。**不要**用 `ConfiguredPackage.filtered`。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/piPackageService.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/electron/app/piPackageService.ts electron-agent/electron/app/piPackageService.test.ts
git commit -m @"
feat(packages): list builtins from production filters and packages by scope

"@
```

---

### 任务 4：`setEnabled` 按 scope 读写（M2，最高优先级）

**文件：**
- 修改：`electron-agent/electron/app/piPackageService.ts`
- 测试：`electron-agent/electron/app/piPackageService.test.ts`

- [ ] **步骤 1：追加失败测试**

```ts
describe('PiPackageService.setEnabled', () => {
  it('does not copy a project package into user settings when disabling it', async () => {
    const settings = fakeSettings({
      global: ['npm:user-pkg@1.0.0'],
      project: [{ source: 'npm:proj-pkg@3.0.0', skills: ['kept'] }],
    });
    const reload = vi.fn(() => true);
    const svc = new PiPackageService({
      agentDir: 'C:/tmp/agent',
      allowedPluginIds: () => [],
      extensions: [],
      requestReload: reload,
      createSettingsManager: () => settings,
      createPackageManager: () => fakeManager([]),
    });
    await svc.setEnabled('C:/ws', 'npm:proj-pkg@9.9.9', 'project', false);
    expect(settings.setPackages).not.toHaveBeenCalled();
    expect(settings.getPackages).not.toHaveBeenCalled();
    expect(settings.setProjectPackages).toHaveBeenCalledTimes(1);
    expect(settings.snapshot().globalPkgs).toEqual(['npm:user-pkg@1.0.0']);
    expect(settings.snapshot().projectPkgs).toEqual([{
      source: 'npm:proj-pkg@3.0.0',
      autoload: false,
      skills: ['kept'],
    }]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not write project settings when disabling a user package', async () => {
    const settings = fakeSettings({
      global: ['npm:user-pkg@1.0.0'],
      project: ['npm:proj-pkg'],
    });
    const svc = new PiPackageService({
      agentDir: 'C:/tmp/agent',
      allowedPluginIds: () => [],
      extensions: [],
      requestReload: vi.fn(() => true),
      createSettingsManager: () => settings,
      createPackageManager: () => fakeManager([]),
    });
    await svc.setEnabled('C:/ws', 'npm:user-pkg@1.0.0', 'user', false);
    expect(settings.setProjectPackages).not.toHaveBeenCalled();
    expect(settings.snapshot().projectPkgs).toEqual(['npm:proj-pkg']);
    expect(settings.snapshot().globalPkgs).toEqual([{ source: 'npm:user-pkg@1.0.0', autoload: false }]);
  });
});
```

再加一条**真实文件**回归（规格原文「用户 settings.json 内容不变」）：

```ts
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsManager } from '../../../cli/src/pi-sdk.js';

it('leaves ~/.pi/agent/settings.json bytes unchanged when toggling a project package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-pkg-m2-'));
  const agentDir = join(root, 'agent');
  const workspace = join(root, 'ws');
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(workspace, '.pi'), { recursive: true });
  const userFile = join(agentDir, 'settings.json');
  await writeFile(userFile, `${JSON.stringify({ packages: ['npm:user-pkg@1.0.0'] }, null, 2)}\n`);
  await writeFile(join(workspace, '.pi/settings.json'), `${JSON.stringify({ packages: ['npm:proj-pkg@3.0.0'] }, null, 2)}\n`);
  const before = await readFile(userFile, 'utf8');
  const svc = new PiPackageService({
    agentDir,
    allowedPluginIds: () => [],
    extensions: [],
    requestReload: () => true,
    createSettingsManager: (cwd, dir) => SettingsManager.create(cwd, dir),
    createPackageManager: () => fakeManager([]),
  });
  await svc.setEnabled(workspace, 'npm:proj-pkg@3.0.0', 'project', false);
  expect(await readFile(userFile, 'utf8')).toBe(before);
  await rm(root, { recursive: true, force: true });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/piPackageService.test.ts
```

预期：FAIL，`setEnabled` is not a function。

- [ ] **步骤 3：实现 `setEnabled`**

```ts
  async setEnabled(workspace: string, source: string, scope: 'user' | 'project', enabled: boolean): Promise<void> {
    this.assertProjectWorkspace(workspace, scope);
    const { settings } = this.open(workspace);
    if (scope === 'user') {
      const current = settings.getGlobalSettings().packages ?? [];
      const matched = findRawEntry(current, source);
      if (!matched) throw new Error('PACKAGE_NOT_FOUND');
      settings.setPackages(replacePackageEntry(current, source, withAutoload(matched, enabled)));
    } else {
      const current = settings.getProjectSettings().packages ?? [];
      const matched = findRawEntry(current, source);
      if (!matched) throw new Error('PACKAGE_NOT_FOUND');
      settings.setProjectPackages(replacePackageEntry(current, source, withAutoload(matched, enabled)));
    }
    this.requestReload();
  }
```

读写表（抄规格，不要偏离）：

| scope | 读 | 写 |
| --- | --- | --- |
| `user` | `getGlobalSettings().packages` | `setPackages` |
| `project` | `getProjectSettings().packages` | `setProjectPackages` |

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/piPackageService.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/electron/app/piPackageService.ts electron-agent/electron/app/piPackageService.test.ts
git commit -m @"
fix(packages): toggle autoload per settings scope without merging packages

"@
```

---

### 任务 5：`install` / `remove` 与 reload（M5）

**文件：**
- 修改：`electron-agent/electron/app/piPackageService.ts`
- 测试：`electron-agent/electron/app/piPackageService.test.ts`

- [ ] **步骤 1：追加失败测试**

```ts
describe('PiPackageService.install and remove', () => {
  it('pins npm:name@version, passes local for project scope, then reloads', async () => {
    const manager = fakeManager([]);
    const reload = vi.fn(() => true);
    const svc = new PiPackageService({
      agentDir: 'C:/tmp/agent',
      allowedPluginIds: () => [],
      extensions: [],
      requestReload: reload,
      createSettingsManager: () => fakeSettings({}),
      createPackageManager: () => manager,
    });
    await svc.install('C:/ws', 'pi-demo', '2.0.0', 'project');
    expect(manager.installAndPersist).toHaveBeenCalledWith('npm:pi-demo@2.0.0', { local: true });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid names with INVALID_PACKAGE', async () => {
    const svc = new PiPackageService({
      agentDir: 'C:/tmp/agent',
      allowedPluginIds: () => [],
      extensions: [],
      createSettingsManager: () => fakeSettings({}),
      createPackageManager: () => fakeManager([]),
    });
    await expect(svc.install('C:/ws', 'UPPER', '1.0.0', 'user')).rejects.toThrow('INVALID_PACKAGE');
    await expect(svc.install('C:/ws', 'ok', 'latest', 'user')).rejects.toThrow('INVALID_PACKAGE');
  });

  it('still reloads when removeAndPersist returns false', async () => {
    const manager = fakeManager([]);
    manager.removeAndPersist = vi.fn(async () => false);
    const reload = vi.fn(() => true);
    const svc = new PiPackageService({
      agentDir: 'C:/tmp/agent',
      allowedPluginIds: () => [],
      extensions: [],
      requestReload: reload,
      createSettingsManager: () => fakeSettings({}),
      createPackageManager: () => manager,
    });
    await svc.remove('C:/ws', 'npm:missing', 'user');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('refuses project install without a workspace', async () => {
    const svc = new PiPackageService({
      agentDir: 'C:/tmp/agent',
      allowedPluginIds: () => [],
      extensions: [],
      createSettingsManager: () => fakeSettings({}),
      createPackageManager: () => fakeManager([]),
    });
    await expect(svc.install('', 'pi-demo', '1.0.0', 'project')).rejects.toThrow('请先打开项目');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

预期：FAIL，`install` is not a function。

- [ ] **步骤 3：实现 install / remove**

```ts
  async install(workspace: string, name: string, version: string, scope: 'user' | 'project'): Promise<void> {
    this.assertProjectWorkspace(workspace, scope);
    if (!isValidNpmName(name) || !isValidSemver(version)) throw new Error('INVALID_PACKAGE');
    const { packages } = this.open(workspace);
    await packages.installAndPersist(pinNpmSource(name, version), { local: scope === 'project' });
    this.requestReload();
  }

  async remove(workspace: string, source: string, scope: 'user' | 'project'): Promise<void> {
    this.assertProjectWorkspace(workspace, scope);
    const { packages } = this.open(workspace);
    await packages.removeAndPersist(source, { local: scope === 'project' });
    this.requestReload();
  }
```

`removeAndPersist` 返回 `false` 时**不抛错**，仍然 reload。未使用的 `packageSourceString` 若 lint 报未用，从 import 里删掉。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/piPackageService.test.ts electron/app/piPackageModel.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/electron/app/piPackageService.ts electron-agent/electron/app/piPackageService.test.ts
git commit -m @"
feat(packages): install and remove npm packages then request resource reload

"@
```

---

### 任务 6：IPC、`pi.ts`、`main.ts`

**文件：**
- 修改：`electron-agent/electron/ipc/register.ts`
- 修改：`electron-agent/electron/ipc/register.test.ts`
- 修改：`electron-agent/electron/main.ts`
- 修改：`electron-agent/src/lib/pi.ts`
- 测试：`electron-agent/electron/ipc/register.test.ts`

- [ ] **步骤 1：编写失败的 IPC 测试**

在 `register.test.ts` 现有 `it('returns serialized plugin state...')` 后面追加：

```ts
  it('routes package commands onto PiPackageService', async () => {
    const piPackages = {
      list: vi.fn(async () => []),
      search: vi.fn(async () => ({ objects: [], total: 0 })),
      install: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      setEnabled: vi.fn(async () => {}),
    };
    registerIpcHandlers({ piPackages } as any);
    const invoke = handler(IPC_CHANNELS.invoke);
    await invoke({}, { command: 'package_list', args: { workspace: '' } });
    await invoke({}, { command: 'package_search', args: { query: '' } });
    await invoke({}, { command: 'package_install', args: { workspace: 'C:/ws', name: 'pi-demo', version: '1.0.0', scope: 'user' } });
    await invoke({}, { command: 'package_remove', args: { workspace: 'C:/ws', source: 'npm:pi-demo@1.0.0', scope: 'user' } });
    await invoke({}, { command: 'package_set_enabled', args: { workspace: 'C:/ws', source: 'npm:pi-demo@1.0.0', scope: 'project', enabled: false } });
    expect(piPackages.list).toHaveBeenCalledWith('');
    expect(piPackages.search).toHaveBeenCalledWith('');
    expect(piPackages.install).toHaveBeenCalledWith('C:/ws', 'pi-demo', '1.0.0', 'user');
    expect(piPackages.remove).toHaveBeenCalledWith('C:/ws', 'npm:pi-demo@1.0.0', 'user');
    expect(piPackages.setEnabled).toHaveBeenCalledWith('C:/ws', 'npm:pi-demo@1.0.0', 'project', false);
  });
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/ipc/register.test.ts
```

预期：FAIL，`Electron command is not registered: package_list`。

- [ ] **步骤 3：接线**

`register.ts`：

1. `import type { PiPackageService } from '../app/piPackageService';`
2. `IpcServices` 增加 `piPackages?: PiPackageService;`（放在 `plugins` 旁）。
3. 在 `if (services.plugins) registerPluginCommands(...)` 后：

```ts
  if (services.piPackages) registerPiPackageCommands(services.piPackages);
```

4. 新增（放在 `registerPluginCommands` 附近）：

```ts
function registerPiPackageCommands(service: PiPackageService): void {
  registerCommand('package_list', (_event, args) => service.list(readOptionalWorkspace(args)));
  registerCommand('package_search', (_event, args) => service.search(readText(args, 'query')));
  registerCommand('package_install', (_event, args) => service.install(
    readOptionalWorkspace(args),
    readString(args, 'name'),
    readString(args, 'version'),
    readPackageScope(args),
  ));
  registerCommand('package_remove', (_event, args) => service.remove(
    readOptionalWorkspace(args),
    readString(args, 'source'),
    readPackageScope(args),
  ));
  registerCommand('package_set_enabled', (_event, args) => service.setEnabled(
    readOptionalWorkspace(args),
    readString(args, 'source'),
    readPackageScope(args),
    readBoolean(args, 'enabled'),
  ));
}

function readOptionalWorkspace(args: Record<string, unknown>): string {
  const value = args.workspace;
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('workspace must be a string');
  return value;
}

function readPackageScope(args: Record<string, unknown>): 'user' | 'project' {
  const value = args.scope;
  if (value !== 'user' && value !== 'project') throw new Error('scope must be user or project');
  return value;
}
```

`readBoolean` / `readText` / `readString` 已在文件底部，直接复用。

`main.ts`：

1. `import { PiPackageService } from "./app/piPackageService";`
2. 在 `await plugins.startAll();` 之后、`registerIpcHandlers({` 之前：

```ts
    const piPackages = new PiPackageService({
      agentDir,
      allowedPluginIds: () => plugins.allowedPluginIds(),
    });
```

3. 把 `piPackages` 放进 `registerIpcHandlers({ ... })` 实参，紧挨 `plugins` 不存在于该对象——当前对象没有 `plugins` 字段，只把 `allowedPluginIds` 传给了 `PiRuntimeService`。`piPackages` 加在 `skills` 附近即可。

`src/lib/pi.ts`：在 `listMcpConfigs` 旁增加方法，并导出类型：

```ts
import type { PackageListItem, PackageSearchResult } from '../../electron/app/piPackageModel';
export type { PackageListItem, PackageSearchResult, MarketplaceHit } from '../../electron/app/piPackageModel';
export type PackageInstallScope = 'user' | 'project';
```

在 `export const pi = {` 内、`listMcpConfigs` 之后：

```ts
  packageList: (workspace: string) =>
    invoke<PackageListItem[]>('package_list', { workspace }),
  packageSearch: (query: string) =>
    invoke<PackageSearchResult>('package_search', { query }),
  packageInstall: (workspace: string, name: string, version: string, scope: PackageInstallScope) =>
    invoke<void>('package_install', { workspace, name, version, scope }),
  packageRemove: (workspace: string, source: string, scope: PackageInstallScope) =>
    invoke<void>('package_remove', { workspace, source, scope }),
  packageSetEnabled: (workspace: string, source: string, scope: PackageInstallScope, enabled: boolean) =>
    invoke<void>('package_set_enabled', { workspace, source, scope, enabled }),
```

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/ipc/register.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/electron/ipc/register.ts electron-agent/electron/ipc/register.test.ts electron-agent/electron/main.ts electron-agent/src/lib/pi.ts
git commit -m @"
feat(packages): expose package list/search/install IPC to the renderer

"@
```

---

### 任务 7：`PiPackagesPanel` 列表与卸载确认

**文件：**
- 创建：`electron-agent/src/features/extensions/PiPackagesPanel.tsx`
- 测试：`electron-agent/src/features/extensions/PiPackagesPanel.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@lobehub/ui';
import type { PackageListItem } from '../../../electron/app/piPackageModel';

const { packageList, packageRemove, packageSetEnabled } = vi.hoisted(() => ({
  packageList: vi.fn(),
  packageRemove: vi.fn(),
  packageSetEnabled: vi.fn(),
}));

vi.mock('../../lib/pi', () => ({
  pi: { packageList, packageRemove, packageSetEnabled },
}));

import { PiPackagesPanel } from './PiPackagesPanel';

vi.setConfig({ testTimeout: 45000 });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const items: PackageListItem[] = [
  { kind: 'builtin', id: 'todo', title: 'todo', scope: 'product', enabled: true, canDisable: false, canRemove: false },
  { kind: 'package', id: 'npm:pi-demo@1.0.0', title: 'pi-demo', scope: 'user', enabled: true, canDisable: true, canRemove: true },
];

function renderPanel(workspace = '/ws') {
  packageList.mockResolvedValue(items);
  return render(
    <ThemeProvider>
      <PiPackagesPanel workspace={workspace} />
    </ThemeProvider>,
  );
}

describe('PiPackagesPanel', () => {
  it('renders builtin rows without an enabled switch and package rows with one', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('package-row-builtin-todo')).toBeTruthy());
    expect(screen.getByTestId('package-row-builtin-todo').textContent).toContain('内置');
    expect(screen.getByTestId('package-row-builtin-todo').querySelector('[data-testid="package-enabled-todo"]')).toBeNull();
    expect(screen.getByTestId('package-row-npm-pi-demo-1.0.0')).toBeTruthy();
    expect(screen.getByTestId('package-enabled-npm-pi-demo-1.0.0')).toBeTruthy();
  });

  it('asks for remove confirmation and does not invoke remove on cancel', async () => {
    packageRemove.mockResolvedValue(undefined);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('package-row-npm-pi-demo-1.0.0')).toBeTruthy());
    fireEvent.click(screen.getByTestId('package-remove-npm-pi-demo-1.0.0'));
    expect(screen.getByTestId('package-remove-confirm')).toBeTruthy();
    fireEvent.click(screen.getByTestId('package-remove-cancel'));
    expect(packageRemove).not.toHaveBeenCalled();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/extensions/PiPackagesPanel.test.tsx
```

预期：FAIL，找不到模块。

- [ ] **步骤 3：实现面板**

要点：

- `createStaticStyles`，hero 复用 `ExtensionsPanel` 的密度（图标 34px、标题 17px）。
- 图标：`Package`（页头）、卸载 `Trash2`，一律 `<Icon icon={...} />`。
- 「浏览市场」按钮 `data-testid="package-marketplace-open"`，本任务只 `setMarketOpen(true)` 并条件渲染 `{marketOpen ? <div data-testid="package-marketplace-modal" /> : null}` 占位。**任务 8 会换成真模态**；占位必须带同一 testid，避免任务 9 的 ExtensionsPanel 测试还没接到真模态时找不到节点。任务 8 删除这个占位 div。
- 内置行：文案 `title` + 徽章「内置」，**不渲染 Switch**。
- 市场行：`Switch` `data-testid={package-enabled-${rowId}}`，`onChange` 调 `pi.packageSetEnabled(workspace, item.id, item.scope, checked)`（`item.scope` 此时必为 `'user' | 'project'`）。
- 卸载：独立 `<Modal data-testid="package-remove-confirm">`，正文 ``确认卸载「{title}」？将从 {scope === 'user' ? '用户设置' : '当前项目'} 移除，并停止加载。`` 取消按钮 `package-remove-cancel`，确认按钮 `package-remove-ok`。确认后 `pi.packageRemove`，`false` 不当错误（IPC 已吞掉）。
- 行 `data-testid={packageRowTestId(item.kind, item.id)}`。
- 从 `../../electron/app/piPackageModel` import `packageRowTestId`。
- 错误条：操作失败显示 `truncateError(String(error))`。
- `workspace` 为空时仍列出内置 + 用户包（服务已过滤项目包）。

组件骨架（必须按此 testid 实现，样式类名可自定）：

```tsx
import { Button, Flexbox, Icon, Modal } from '@lobehub/ui';
import { Switch } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { Package, Store, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { pi, type PackageListItem } from '../../lib/pi';
import { packageRowTestId, truncateError } from '../../../electron/app/piPackageModel';

export function PiPackagesPanel({ workspace }: { workspace: string }) {
  const [items, setItems] = useState<PackageListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [marketOpen, setMarketOpen] = useState(false);
  const [removing, setRemoving] = useState<PackageListItem | null>(null);

  const reload = useCallback(async () => {
    try {
      setItems(await pi.packageList(workspace));
      setError(null);
    } catch (cause) {
      setError(truncateError(cause instanceof Error ? cause.message : String(cause)));
    }
  }, [workspace]);

  useEffect(() => { void reload(); }, [reload]);

  const packageCount = items.filter((item) => item.kind === 'package').length;
  const enabledTestId = (item: PackageListItem) =>
    `package-enabled-${item.kind === 'builtin' ? item.id : item.id.replace(/[^a-zA-Z0-9._-]+/g, '-')}`;
  const removeTestId = (item: PackageListItem) =>
    `package-remove-${item.id.replace(/[^a-zA-Z0-9._-]+/g, '-')}`;

  return (
    <div>
      <div className={styles.heroBar}>
        <div className={styles.hero}>
          <span className={styles.heroIcon}><Icon icon={Package} size={18} /></span>
          <span className={styles.heroTitle}>
            扩展
            {packageCount > 0 ? <span className={styles.count}>{packageCount}</span> : null}
          </span>
        </div>
        <Button size="small" icon={<Icon icon={Store} size={14} />} data-testid="package-marketplace-open" onClick={() => setMarketOpen(true)}>
          浏览市场
        </Button>
      </div>
      <div className={styles.heroDesc}>编译进产品的扩展只读展示。市场安装的包可开关或卸载，写入官方 settings 后在会话空闲时加载。</div>
      {error ? <div className={styles.errorBar}>{error}</div> : null}
      {items.map((item) => (
        <div key={`${item.kind}:${item.id}`} className={styles.row} data-testid={packageRowTestId(item.kind, item.id)}>
          <div>
            <div>{item.title}{item.kind === 'builtin' ? <span className={styles.badge}>内置</span> : null}</div>
            <div className={styles.meta}>{item.kind === 'builtin' ? '产品' : item.scope === 'user' ? '用户级' : '当前项目'}</div>
          </div>
          <Flexbox horizontal align="center" gap={8}>
            {item.canDisable ? (
              <Switch
                size="small"
                checked={item.enabled}
                data-testid={enabledTestId(item)}
                onChange={(checked) => {
                  if (item.scope === 'product') return;
                  void pi.packageSetEnabled(workspace, item.id, item.scope, checked).then(reload).catch((cause) => {
                    setError(truncateError(cause instanceof Error ? cause.message : String(cause)));
                  });
                }}
              />
            ) : null}
            {item.canRemove ? (
              <Button size="small" icon={<Icon icon={Trash2} size={14} />} data-testid={removeTestId(item)} onClick={() => setRemoving(item)}>
                卸载
              </Button>
            ) : null}
          </Flexbox>
        </div>
      ))}
      <Modal
        open={!!removing}
        title="卸载扩展"
        data-testid="package-remove-confirm"
        onCancel={() => setRemoving(null)}
        footer={
          <>
            <Button data-testid="package-remove-cancel" onClick={() => setRemoving(null)}>取消</Button>
            <Button
              data-testid="package-remove-ok"
              danger
              onClick={() => {
                if (!removing || removing.scope === 'product') return;
                void pi.packageRemove(workspace, removing.id, removing.scope).then(() => {
                  setRemoving(null);
                  return reload();
                }).catch((cause) => {
                  setError(truncateError(cause instanceof Error ? cause.message : String(cause)));
                });
              }}
            >
              确认卸载
            </Button>
          </>
        }
      >
        {removing ? `确认卸载「${removing.title}」？将从 ${removing.scope === 'user' ? '用户设置' : '当前项目'} 移除，并停止加载。` : null}
      </Modal>
      {marketOpen ? <div data-testid="package-marketplace-modal" /> : null}
    </div>
  );
}

const styles = createStaticStyles(({ css }) => ({
  heroBar: css`display:flex;align-items:center;justify-content:space-between;gap:10px;`,
  hero: css`display:flex;align-items:center;gap:10px;`,
  heroIcon: css`display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;flex:0 0 auto;border-radius:8px;background:${cssVar.colorFillTertiary};color:${cssVar.colorText};`,
  heroTitle: css`display:inline-flex;align-items:center;font-size:17px;font-weight:600;color:${cssVar.colorText};`,
  count: css`margin-inline-start:8px;padding:1px 8px;border-radius:999px;background:${cssVar.colorFillSecondary};color:${cssVar.colorTextSecondary};font-size:12px;font-weight:500;`,
  heroDesc: css`margin-block:8px 16px;font-size:13px;line-height:1.55;color:${cssVar.colorTextSecondary};`,
  errorBar: css`margin-block-end:12px;padding:8px 12px;background:${cssVar.colorErrorBg};color:${cssVar.colorError};font-size:12px;`,
  row: css`display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-block-end:1px solid ${cssVar.colorBorderSecondary};`,
  badge: css`margin-inline-start:8px;padding:1px 6px;border-radius:999px;background:${cssVar.colorFillSecondary};font-size:11px;color:${cssVar.colorTextSecondary};`,
  meta: css`margin-block-start:2px;font-size:12px;color:${cssVar.colorTextTertiary};`,
}));
```

把模板字符串里的 CSS 写成与 `NativeSkillsPanel` 相同的多行 `css\`...\`` 形式，不要真的挤成一行。上面写成一行只是为了计划紧凑；实现时按现有面板风格展开。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/extensions/PiPackagesPanel.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/src/features/extensions/PiPackagesPanel.tsx electron-agent/src/features/extensions/PiPackagesPanel.test.tsx
git commit -m @"
feat(packages): show builtin and marketplace packages on the extensions tab

"@
```

---

### 任务 8：市场模态与安装确认（S1 / S2 / S4）

**文件：**
- 创建：`electron-agent/src/features/extensions/PackageMarketplaceModal.tsx`
- 测试：`electron-agent/src/features/extensions/PackageMarketplaceModal.test.tsx`
- 修改：`electron-agent/src/features/extensions/PiPackagesPanel.tsx`（换成真模态，删占位 div）

- [ ] **步骤 1：编写失败的测试**

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@lobehub/ui';

const { packageSearch, packageInstall } = vi.hoisted(() => ({
  packageSearch: vi.fn(),
  packageInstall: vi.fn(),
}));

vi.mock('../../lib/pi', () => ({
  pi: { packageSearch, packageInstall },
}));

import { PackageMarketplaceModal } from './PackageMarketplaceModal';

vi.setConfig({ testTimeout: 45000 });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderModal(workspace = '/ws') {
  packageSearch.mockResolvedValue({
    total: 9908,
    objects: [{ name: 'pi-demo', version: '2.0.0', description: 'd', publisher: 'ada', npmUrl: 'https://www.npmjs.com/package/pi-demo' }],
  });
  return render(
    <ThemeProvider>
      <PackageMarketplaceModal
        open
        workspace={workspace}
        installedNames={['other']}
        onClose={() => {}}
        onInstalled={() => {}}
      />
    </ThemeProvider>,
  );
}

describe('PackageMarketplaceModal', () => {
  it('searches from the input and shows the total count caption', async () => {
    renderModal();
    await waitFor(() => expect(packageSearch).toHaveBeenCalledWith(''));
    fireEvent.change(screen.getByTestId('package-marketplace-search'), { target: { value: 'demo' } });
    fireEvent.keyDown(screen.getByTestId('package-marketplace-search'), { key: 'Enter' });
    await waitFor(() => expect(packageSearch).toHaveBeenCalledWith('demo'));
    expect(screen.getByTestId('package-marketplace-total').textContent).toBe('共 9908 个结果，展示前 20 个');
  });

  it('opens the confirm modal and does not install when cancelled', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByTestId('package-install-pi-demo')).toBeTruthy());
    fireEvent.click(screen.getByTestId('package-install-pi-demo'));
    expect(screen.getByTestId('package-install-confirm')).toBeTruthy();
    expect(screen.getByTestId('package-install-confirm').textContent).toContain('npm:pi-demo@2.0.0');
    expect(screen.getByTestId('package-install-confirm').textContent).toContain('该包将以本机完整权限运行，可执行任意代码。');
    fireEvent.click(screen.getByTestId('package-install-cancel'));
    expect(packageInstall).not.toHaveBeenCalled();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/extensions/PackageMarketplaceModal.test.tsx
```

预期：FAIL，找不到模块。

- [ ] **步骤 3：实现模态**

写入 `PackageMarketplaceModal.tsx`。确认框必须是第二个 `<Modal>`，禁止 `Modal.confirm`。

```tsx
import { Button, Flexbox, Icon, Modal } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { pi, type PackageInstallScope, type MarketplaceHit } from '../../lib/pi';
import { pinNpmSource, truncateError } from '../../../electron/app/piPackageModel';

interface Props {
  open: boolean;
  workspace: string;
  installedNames: string[];
  onClose(): void;
  onInstalled(): void;
}

export function PackageMarketplaceModal({ open, workspace, installedNames, onClose, onInstalled }: Props) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<PackageInstallScope>('user');
  const [hits, setHits] = useState<MarketplaceHit[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<MarketplaceHit | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void runSearch('');
  }, [open]);

  async function runSearch(text: string) {
    try {
      const result = await pi.packageSearch(text);
      setHits(result.objects);
      setTotal(result.total);
      setError(null);
    } catch (cause) {
      setError(`市场搜索失败：${truncateError(cause instanceof Error ? cause.message : String(cause))}`);
    }
  }

  const scopeLabel = scope === 'user' ? '用户级' : '当前项目';
  const projectDisabled = !workspace.trim();

  return (
    <>
      <Modal open={open} title="扩展市场" footer={null} onCancel={onClose} data-testid="package-marketplace-modal" width={640}>
        <input
          data-testid="package-marketplace-search"
          value={query}
          className={styles.input}
          placeholder="搜索包名"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(query); }}
        />
        <Button size="small" icon={<Icon icon={Search} size={14} />} onClick={() => void runSearch(query)}>搜索</Button>
        <Flexbox horizontal gap={8} style={{ marginBlock: 12 }}>
          <Button size="small" type={scope === 'user' ? 'primary' : 'default'} onClick={() => setScope('user')}>用户级</Button>
          <Button size="small" type={scope === 'project' ? 'primary' : 'default'} disabled={projectDisabled} onClick={() => setScope('project')}>当前项目</Button>
          {projectDisabled ? <span className={styles.hint}>先打开一个项目</span> : null}
        </Flexbox>
        {error ? <div className={styles.errorBar}>{error}</div> : null}
        {hits.map((hit) => {
          const installed = installedNames.includes(hit.name);
          return (
            <div key={hit.name} className={styles.row}>
              <div>
                <div>{hit.name}@{hit.version}</div>
                <div className={styles.meta}>{hit.description} · {hit.publisher}</div>
              </div>
              <Button
                size="small"
                data-testid={`package-install-${hit.name}`}
                disabled={installed || installing === hit.name || (scope === 'project' && projectDisabled)}
                loading={installing === hit.name}
                onClick={() => setPending(hit)}
              >
                {installed ? '已安装' : '安装'}
              </Button>
            </div>
          );
        })}
        <div data-testid="package-marketplace-total">共 {total} 个结果，展示前 20 个</div>
      </Modal>
      <Modal
        open={!!pending}
        title="确认安装"
        data-testid="package-install-confirm"
        onCancel={() => { if (!installing) setPending(null); }}
        footer={
          <>
            <Button data-testid="package-install-cancel" disabled={!!installing} onClick={() => setPending(null)}>取消</Button>
            <Button
              data-testid="package-install-ok"
              type="primary"
              loading={!!installing}
              onClick={() => {
                if (!pending) return;
                const target = pending;
                setInstalling(target.name);
                void pi.packageInstall(workspace, target.name, target.version, scope).then(() => {
                  setPending(null);
                  setInstalling(null);
                  onInstalled();
                }).catch((cause) => {
                  setInstalling(null);
                  setError(truncateError(cause instanceof Error ? cause.message : String(cause)));
                });
              }}
            >
              确认安装
            </Button>
          </>
        }
      >
        {pending ? (
          <div>
            <p>包名：{pending.name}</p>
            <p>版本：{pending.version}</p>
            <p>来源：{pinNpmSource(pending.name, pending.version)}</p>
            <p>范围：{scopeLabel}</p>
            <p>该包将以本机完整权限运行，可执行任意代码。</p>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

const styles = createStaticStyles(({ css }) => ({
  input: css`
    width: 100%;
    margin-block-end: 8px;
    padding: 9px 11px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 9px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};
  `,
  hint: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  errorBar: css`
    margin-block-end: 12px;
    padding: 8px 12px;
    background: ${cssVar.colorErrorBg};
    color: ${cssVar.colorError};
    font-size: 12px;
  `,
  row: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 0;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  meta: css`
    margin-block-start: 2px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
}));
```

`src/lib/pi.ts` 需再导出 `MarketplaceHit`（任务 6 已写 `export type { ..., MarketplaceHit }`）。若任务 6 漏了，这里补上。

实现后改 `PiPackagesPanel`：

```tsx
import { PackageMarketplaceModal } from './PackageMarketplaceModal';
```

把占位 `<div data-testid="package-marketplace-modal" />` 换成：

```tsx
<PackageMarketplaceModal
  open={marketOpen}
  workspace={workspace}
  installedNames={items.filter((item) => item.kind === 'package').map((item) => item.title)}
  onClose={() => setMarketOpen(false)}
  onInstalled={() => { void reload(); }}
/>
```

`installedNames` 用 `npmNameFromSource(item.id)` 更稳（title 已是去版本的包名，任务 3 已保证）。继续用 `item.title` 即可。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/extensions/PackageMarketplaceModal.test.tsx src/features/extensions/PiPackagesPanel.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/src/features/extensions/PackageMarketplaceModal.tsx electron-agent/src/features/extensions/PackageMarketplaceModal.test.tsx electron-agent/src/features/extensions/PiPackagesPanel.tsx
git commit -m @"
feat(packages): add npm marketplace modal with an in-tree install confirm

"@
```

---

### 任务 9：ExtensionsPanel 三个 tab（MCP 正名）

**文件：**
- 修改：`electron-agent/src/features/extensions/ExtensionsPanel.tsx`
- 修改：`electron-agent/src/features/extensions/ExtensionsPanel.test.tsx`

- [ ] **步骤 1：改失败测试**

把 `it('exposes MCP and the native local Skills tab, without retired code intelligence')` 整段换成：

```ts
  it('exposes MCP, packages, and skills tabs, without retired code intelligence', async () => {
    getSettings.mockResolvedValueOnce({});
    render(<ExtensionsPanel />);
    await waitFor(() => expect(screen.getByTestId('ext-tab-mcp')).toBeTruthy());
    expect(screen.getByTestId('ext-tab-mcp').textContent).toContain('MCP');
    expect(screen.getByTestId('ext-tab-mcp').textContent).not.toContain('插件');
    expect(screen.getByTestId('ext-tab-packages')).toBeTruthy();
    expect(screen.getByTestId('ext-tab-packages').textContent).toContain('扩展');
    expect(screen.getByTestId('ext-tab-skills')).toBeTruthy();
    expect(screen.queryByTestId('ext-tab-code-intel')).toBeNull();
  });
```

`vi.mock('../../lib/pi')` 补上 `packageList: vi.fn(() => Promise.resolve([]))`，以及 `useOptionalAgentStoreContext`：

```ts
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
  useOptionalAgentStoreContext: () => ({ workspace: '/ws' }),
}));
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/extensions/ExtensionsPanel.test.tsx
```

预期：FAIL，MCP 按钮仍是「插件」，没有 `ext-tab-packages`。

- [ ] **步骤 3：改面板**

1. lucide import：删 `Boxes`，加 `Server, Package`。技能仍 `Sparkles`。
2. `useState<'mcp' | 'packages' | 'skills'>('mcp')` —— 默认仍是 MCP。
3. tab 按钮：

```tsx
<button type="button" className={`${styles.tab} ${tab === 'mcp' ? styles.tabActive : ''}`} data-testid="ext-tab-mcp" onClick={() => setTab('mcp')}>
  <Icon icon={Server} size={15} />
  MCP
</button>
<button type="button" className={`${styles.tab} ${tab === 'packages' ? styles.tabActive : ''}`} data-testid="ext-tab-packages" onClick={() => setTab('packages')}>
  <Icon icon={Package} size={15} />
  扩展
</button>
<button type="button" className={`${styles.tab} ${tab === 'skills' ? styles.tabActive : ''}`} data-testid="ext-tab-skills" onClick={() => setTab('skills')}>
  <Icon icon={Sparkles} size={15} />
  技能
</button>
```

从 `@lobehub/ui` 的现有 `Button, Flexbox` import 补 `Icon`。

4. 页头 MCP 图标同样换成 `Server`（heroIcon 里那枚 `Boxes`）。
5. body 分支改为：

```tsx
{tab === 'skills' ? (
  <NativeSkillsPanel values={values} setValue={setValue} onChanged={markChanged} />
) : tab === 'packages' ? (
  <PiPackagesPanel workspace={workspace} />
) : (
  <>
    {/* 现有 MCP 列表，一字不改除 Boxes → Server */}
  </>
)}
```

6. `import { PiPackagesPanel } from './PiPackagesPanel';`

不要改 MCP 添加/删除/权限逻辑。不要改 ModuleRail。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/extensions/ExtensionsPanel.test.tsx src/features/extensions/PiPackagesPanel.test.tsx src/features/extensions/PackageMarketplaceModal.test.tsx electron/app/piPackageService.test.ts electron/app/piPackageModel.test.ts electron/ipc/register.test.ts
```

预期：全部 PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/src/features/extensions/ExtensionsPanel.tsx electron-agent/src/features/extensions/ExtensionsPanel.test.tsx
git commit -m @"
feat(packages): rename the MCP tab and add the extensions marketplace tab

"@
```

---

### 任务 10：架构文档一句

**文件：**
- 修改：`docs/architecture.md`（「### extensions —— 内置扩展包」段，约第 44–48 行）

- [ ] **步骤 1：改文档**

在该段第一段末（`extensions/package.json` 那句之后）追加：

```
桌面端经 `PiPackageService` 管理官方 `settings.packages`：扩展 tab 列出当前会话实际会加载的内置工厂（`filterManagedExtensions(filterExtensionsByProfile(manifestExtensions, profile), allowedPluginIds)`，与 `gren-runtime` 同源）以及用户 / 项目安装的 Pi Package；市场检索 npm `keywords:pi-package`，安装走 SDK `DefaultPackageManager`，写入后 `requestResourceReload()`。
```

中英文之间留空格。不改 `docs/pi/packages.md`。不改内置扩展表。

- [ ] **步骤 2：Commit**（用户未要求则跳过）

```powershell
git add docs/architecture.md
git commit -m @"
docs: note desktop Pi package management on the extensions panel

"@
```

---

## 规格对照

| 规格 | 任务 |
| --- | --- |
| §1 成功标准 1 MCP 正名 | 9 |
| §1 成功标准 2 扩展 tab | 7, 9 |
| §1 成功标准 3 市场搜索 | 2, 8 |
| §1 成功标准 4 installAndPersist 钉版本 | 5 |
| §1 成功标准 5 reload | 4, 5 |
| §1 成功标准 6 内置只读 | 3, 7 |
| §2 信息架构三 tab | 9 |
| §3.1 M1 enabled 推导 | 1, 3 |
| §3.1 M3 生产过滤器 | 3 |
| §3.2 开关 / 卸载 / M5 false | 4, 5, 7 |
| §4.1 S1 总数 S2 净化 S3 不翻页 | 1, 2, 8 |
| §4.2 确认安装 | 8 |
| §5 M2 跨 scope M4 agentDir | 4, 6 |
| §6 S4 独立确认模态与 testid | 7, 8 |
| §7 INVALID_PACKAGE / 未打开项目 | 5, 8 |
| §8 测试表 | 1–9 |
| §9 architecture.md | 10 |
| 非目标（Chord / git / 关内置 / 散落 extensions） | 不实现 |
