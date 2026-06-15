# 设置页视觉重构实现计划 — 分组导航 / 卡片化 / 控件升级

> **面向 AI 代理的工作者：** 用 `superpowers:executing-plans` 逐任务**内联**实现（本仓库**禁止子代理**）。复选框 `- [ ]` 跟踪，每任务结尾 commit。

**目标：** 设置页重构为「图标分组导航 + 卡片化 + 控件升级 + 描述行」。设计依据：`docs/superpowers/specs/2026-06-15-settings-redesign-design.md`。

**架构**：纯前端渲染 + schema 增强；env 存储 / `useSettingsForm` / 「保存并重启」/ env key 全不变。

**技术栈**：React 19 + TS + `@lobehub/ui` + `antd` + `antd-style` + `lucide-react`。

**关键契约（务必保持，否则破坏现有测试/复用方）**：
- testid：导航项 `set-cat-{id}`、字段 `{testIdPrefix}-{key}`（默认 `set-field`）、保存 `set-save`。
- `SettingFieldInput` 被 `ConnectionsPanel` 复用（`testIdPrefix='conn-field'`），签名 `{ field, value, onChange, testIdPrefix? }` 必须保持兼容。
- boolean 存 `'1'/'0'`、number 存字符串。

**命令约定**：
- 前端单测：`cd tauri-agent && npx vitest run src/features/settings/<file>`
- 类型检查：`cd tauri-agent && npx tsc --noEmit`
- 构建验证（最终门）：`cd tauri-agent && npm run build`

> **STOP 条件**：若 `npx vitest` / `tsc` 找不到，改 `npx -y`；仍失败则停止报告，不要改测试框架或 tsconfig。

---

## 文件结构

**修改**
- `tauri-agent/src/features/settings/settingsSchema.ts` — 类型增强 + 字段元数据（group/icon/description，记忆分 sections）
- `tauri-agent/src/features/settings/SettingField.tsx` — 重写：行布局 + 控件分发（Switch/InputNumber/Select/Input），保持 testid 与签名
- `tauri-agent/src/features/settings/SettingsPanel.tsx` — 重写：分组导航 + 卡片内容
- `tauri-agent/src/features/settings/SettingsPanel.test.tsx` — 更新断言（分组/卡片/控件）

**新增**
- `tauri-agent/src/features/settings/SettingCard.tsx` — 卡片容器
- `tauri-agent/src/features/settings/settingsSchema.test.ts` — schema 完整性单测

---

# 任务 T1：schema 增强 + 字段元数据

**文件**：修改 `settingsSchema.ts`；新增 `settingsSchema.test.ts`

- [ ] **步骤 1：写 schema 完整性测试**

创建 `tauri-agent/src/features/settings/settingsSchema.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA, SETTING_GROUPS } from './settingsSchema';

describe('SETTINGS_SCHEMA', () => {
  it('every category has group + icon + title', () => {
    for (const c of SETTINGS_SCHEMA) {
      expect(c.group, c.id).toBeTruthy();
      expect(c.icon, c.id).toBeTruthy();
      expect(c.title, c.id).toBeTruthy();
      expect(Boolean(c.fields) || Boolean(c.sections), `${c.id} has fields or sections`).toBe(true);
    }
  });

  it('every group in SETTING_GROUPS is used and ordering is stable', () => {
    const used = new Set(SETTINGS_SCHEMA.map((c) => c.group));
    for (const g of used) expect(SETTING_GROUPS).toContain(g);
  });

  it('select fields declare options', () => {
    const allFields = SETTINGS_SCHEMA.flatMap((c) => c.sections?.flatMap((s) => s.fields) ?? c.fields ?? []);
    for (const f of allFields) {
      if (f.type === 'select') expect(f.options?.length, f.key).toBeGreaterThan(0);
    }
  });

  it('memory category is split into sections', () => {
    const mem = SETTINGS_SCHEMA.find((c) => c.id === 'memory');
    expect(mem?.sections?.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

`cd tauri-agent && npx vitest run src/features/settings/settingsSchema.test.ts` — 预期 FAIL（`SETTING_GROUPS` 未导出 / category 无 group）。

- [ ] **步骤 3：重写 `settingsSchema.ts`**

整体替换为（env key 全部沿用，仅加元数据 + 精简 label + 拆 description）：

```ts
import { AudioLines, BookOpen, Boxes, Brain, Globe, Image, Settings2, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type FieldType = 'text' | 'password' | 'number' | 'boolean' | 'select';
export type SettingGroup = '核心' | '能力' | '联网' | '扩展与安全';

export const SETTING_GROUPS: SettingGroup[] = ['核心', '能力', '联网', '扩展与安全'];

export interface SelectOption {
  value: string;
  label: string;
}

export interface SettingField {
  key: string;
  label: string;
  type: FieldType;
  description?: string;
  placeholder?: string;
  options?: SelectOption[];
}

export interface SettingSection {
  title: string;
  fields: SettingField[];
}

export interface SettingCategory {
  id: string;
  title: string;
  group: SettingGroup;
  icon: LucideIcon;
  fields?: SettingField[];
  sections?: SettingSection[];
}

export const SETTINGS_SCHEMA: SettingCategory[] = [
  {
    id: 'general',
    title: '通用与模型',
    group: '核心',
    icon: Settings2,
    fields: [
      { key: 'OPENAI_API_KEY', label: 'OpenAI API Key', type: 'password', placeholder: 'sk-...', description: '全局兜底密钥，各能力未单独配置时共用' },
      { key: 'titleModel', label: '对话标题模型', type: 'text', placeholder: '如 anthropic/claude-haiku', description: 'provider/id；留空＝自动选轻量模型' },
    ],
  },
  {
    id: 'knowledge',
    title: '知识库',
    group: '能力',
    icon: BookOpen,
    fields: [
      { key: 'KB_AUTO_INJECT', label: '自动注入', type: 'boolean', description: '检索到的知识自动注入上下文' },
      { key: 'KB_AUTO_TOPK', label: '自动注入条数', type: 'number', placeholder: '3', description: '每次注入的知识块上限' },
      { key: 'KB_EMBED_API_KEY', label: 'Embedding API Key', type: 'password', description: '向量化所用密钥' },
      { key: 'KB_EMBED_BASE_URL', label: 'Embedding Base URL', type: 'text', placeholder: 'https://api.openai.com/v1', description: 'OpenAI 兼容端点' },
      { key: 'KB_EMBED_MODEL', label: 'Embedding 模型', type: 'text', placeholder: 'text-embedding-3-small' },
    ],
  },
  {
    id: 'memory',
    title: '记忆',
    group: '能力',
    icon: Brain,
    sections: [
      {
        title: '记忆召回',
        fields: [
          { key: 'MEMORY_AUTO_INJECT', label: '自动注入记忆', type: 'boolean', description: '每次提问自动召回相关记忆并注入上下文' },
          { key: 'MEMORY_AUTO_TOPK', label: '自动召回条数', type: 'number', placeholder: '5', description: '每次注入的记忆条数上限' },
          { key: 'MEMORY_AUTO_CAPTURE', label: '捕获“记住”指令', type: 'boolean', description: '用户说“记住：…”时自动保存' },
          { key: 'MEMORY_EMBED_API_KEY', label: 'Embedding API Key', type: 'password', description: '语义召回所用密钥；留空则降级关键词召回' },
          { key: 'MEMORY_EMBED_MODEL', label: 'Embedding 模型', type: 'text', placeholder: 'text-embedding-3-small' },
        ],
      },
      {
        title: '记忆维护',
        fields: [
          { key: 'MEMORY_SMART', label: '智能合并', type: 'boolean', description: '由 LLM 决策新增/更新/删除，自动消解重复与矛盾' },
          { key: 'MEMORY_MODEL', label: '记忆模型', type: 'text', placeholder: '如 openai/gpt-4o-mini', description: '智能合并/提取所用模型；留空＝继承当前对话模型' },
          { key: 'MEMORY_EXTRACT', label: '对话提取记忆', type: 'boolean', description: '每轮对话后抽取要点入库（会多一次 LLM 调用，默认关）' },
          { key: 'MEMORY_SMART_NOTICE', label: '合并时提示', type: 'boolean', description: '记忆被更新或删除时在对话里提示' },
        ],
      },
    ],
  },
  {
    id: 'image',
    title: '图像生成',
    group: '能力',
    icon: Image,
    fields: [
      { key: 'IMAGE_API_KEY', label: 'Image API Key', type: 'password' },
      { key: 'IMAGE_BASE_URL', label: 'Base URL', type: 'text', placeholder: 'https://api.openai.com/v1' },
      { key: 'IMAGE_MODEL', label: '模型', type: 'text', placeholder: 'gpt-image-1' },
      { key: 'IMAGE_SIZE', label: '尺寸', type: 'text', placeholder: '1024x1024' },
    ],
  },
  {
    id: 'tts',
    title: '语音 TTS',
    group: '能力',
    icon: AudioLines,
    fields: [
      { key: 'TTS_API_KEY', label: 'TTS API Key', type: 'password' },
      { key: 'TTS_BASE_URL', label: 'Base URL', type: 'text', placeholder: 'https://api.openai.com/v1' },
      { key: 'TTS_MODEL', label: '模型', type: 'text', placeholder: 'gpt-4o-mini-tts' },
      { key: 'TTS_VOICE', label: '音色', type: 'text', placeholder: 'alloy' },
      { key: 'TTS_FORMAT', label: '格式', type: 'text', placeholder: 'mp3' },
    ],
  },
  {
    id: 'web',
    title: '网页 / 搜索 / 子代理',
    group: '联网',
    icon: Globe,
    sections: [
      {
        title: '网页抓取',
        fields: [
          { key: 'FETCH_MAX_CHARS', label: '抓取最大字符', type: 'number', placeholder: '20000' },
          { key: 'FETCH_TIMEOUT_MS', label: '抓取超时(ms)', type: 'number', placeholder: '15000' },
        ],
      },
      {
        title: '搜索',
        fields: [
          { key: 'WEB_SEARCH_PROVIDER', label: '搜索引擎', type: 'text', placeholder: 'bing', description: '留空且无 key 时自动 bing；失败按引擎链回退' },
          { key: 'WEB_SEARCH_ENGINES', label: '搜索引擎链', type: 'text', placeholder: 'bing,sogou,baidu', description: '逗号分隔，如 bing,sogou,baidu,csdn,juejin' },
          { key: 'TAVILY_API_KEY', label: 'Tavily API Key', type: 'password', placeholder: 'tvly-...' },
          { key: 'BRAVE_API_KEY', label: 'Brave Search API Key', type: 'password' },
        ],
      },
      {
        title: '子代理',
        fields: [
          { key: 'SUBAGENT_TIMEOUT_MS', label: '子代理超时(ms)', type: 'number', placeholder: '120000' },
          { key: 'SUBAGENT_MODEL', label: '子代理模型', type: 'text', placeholder: '如 deepseek/deepseek-chat', description: '留空＝继承主代理默认' },
          { key: 'PI_BIN', label: '子代理可执行文件', type: 'text', description: '留空＝复用本体 sidecar' },
        ],
      },
    ],
  },
  {
    id: 'mcp',
    title: 'MCP 服务器',
    group: '扩展与安全',
    icon: Boxes,
    fields: [
      { key: 'MCP_SERVERS', label: 'MCP Servers（JSON）', type: 'text', placeholder: '{"mcpServers":{...}}', description: '其工具以 mcp__server__tool 暴露给 agent' },
      { key: 'OPEN_WEBSEARCH', label: 'open-webSearch MCP', type: 'text', placeholder: '0', description: '已内置 baidu/csdn/掘金；填 1 才额外拉起 npx MCP' },
    ],
  },
  {
    id: 'safety',
    title: '安全',
    group: '扩展与安全',
    icon: ShieldCheck,
    fields: [
      { key: 'SAFETY_BASH_CONFIRM', label: '危险命令前确认', type: 'boolean', description: '执行危险 bash 命令前弹确认（默认开）' },
      { key: 'SAFETY_PROTECT_PATHS', label: '保护敏感路径', type: 'boolean', description: '阻断写 .env/.git/node_modules/密钥（默认开）' },
    ],
  },
];

/** 连接（im-gateway）字段单列，供 ConnectionsPanel 复用同一存储。 */
export const CONNECTION_FIELDS: SettingField[] = [
  { key: 'IM_GATEWAY', label: '启用网关', type: 'boolean', description: '开启后可经 im-gateway 接入外部 IM' },
  { key: 'IM_GATEWAY_PORT', label: '端口', type: 'number', placeholder: '8765' },
  { key: 'IM_GATEWAY_TOKEN', label: 'Token（可选）', type: 'password' },
];
```

- [ ] **步骤 4：运行测试验证通过**

`cd tauri-agent && npx vitest run src/features/settings/settingsSchema.test.ts` — 预期 PASS（4 用例）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/settings/settingsSchema.ts tauri-agent/src/features/settings/settingsSchema.test.ts
git commit -m "feat(settings): enrich schema with group/icon/description and sections"
```

---

# 任务 T2：`SettingField` 重写（控件分发 + 描述行）

**文件**：修改 `SettingField.tsx`（保持 `SettingFieldInput` 导出与签名）

- [ ] **步骤 1：补充控件测试**

新增 `tauri-agent/src/features/settings/SettingField.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingFieldInput } from './SettingField';

afterEach(cleanup);

describe('SettingFieldInput', () => {
  it('boolean renders a switch and toggles 1/0', () => {
    const onChange = vi.fn();
    render(<SettingFieldInput field={{ key: 'X', label: 'X', type: 'boolean' }} value="0" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('set-field-X'));
    expect(onChange).toHaveBeenCalledWith('1');
  });

  it('text input reflects value and emits changes', () => {
    const onChange = vi.fn();
    render(<SettingFieldInput field={{ key: 'Y', label: 'Y', type: 'text' }} value="a" onChange={onChange} />);
    const el = screen.getByTestId('set-field-Y') as HTMLInputElement;
    expect(el.value).toBe('a');
    fireEvent.change(el, { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('renders description and honors testIdPrefix', () => {
    render(
      <SettingFieldInput
        field={{ key: 'Z', label: 'Z', type: 'text', description: 'hello desc' }}
        value=""
        onChange={() => {}}
        testIdPrefix="conn-field"
      />,
    );
    expect(screen.getByTestId('conn-field-Z')).toBeTruthy();
    expect(screen.getByText('hello desc')).toBeTruthy();
  });

  it('select emits chosen option value', () => {
    const onChange = vi.fn();
    render(
      <SettingFieldInput
        field={{ key: 'S', label: 'S', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }}
        value="a"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('set-field-S')).toBeTruthy();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

`cd tauri-agent && npx vitest run src/features/settings/SettingField.test.tsx` — 预期 FAIL（旧实现无 description 渲染 / 无 select）。

- [ ] **步骤 3：重写 `SettingField.tsx`**

整体替换为：

```tsx
import { Flexbox } from '@lobehub/ui';
import { Input, InputNumber, Select, Switch } from 'antd';
import { createStyles } from 'antd-style';
import type { SettingField } from './settingsSchema';

const useStyles = createStyles(({ css, token }) => ({
  row: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-block: 10px;
  `,
  meta: css`
    min-width: 0;
  `,
  label: css`
    font-size: 13px;
    color: ${token.colorText};
  `,
  desc: css`
    margin-block-start: 2px;
    font-size: 12px;
    color: ${token.colorTextDescription};
  `,
  control: css`
    flex: 0 0 auto;
  `,
  wide: css`
    flex: 1 1 auto;
    min-width: 0;
  `,
}));

interface Props {
  field: SettingField;
  value: string;
  onChange: (v: string) => void;
  /** testid 前缀，默认 set-field；连接面板用 conn-field。 */
  testIdPrefix?: string;
}

export function SettingFieldInput({ field, value, onChange, testIdPrefix = 'set-field' }: Props) {
  const { styles, cx } = useStyles();
  const testId = `${testIdPrefix}-${field.key}`;
  const on = value === '1' || value.toLowerCase() === 'true';

  const control = () => {
    switch (field.type) {
      case 'boolean':
        return (
          <Switch
            data-testid={testId}
            checked={on}
            onChange={(checked) => onChange(checked ? '1' : '0')}
          />
        );
      case 'number':
        return (
          <InputNumber
            data-testid={testId}
            value={value === '' ? null : Number(value)}
            placeholder={field.placeholder}
            onChange={(n) => onChange(n == null ? '' : String(n))}
          />
        );
      case 'select':
        return (
          <Select
            data-testid={testId}
            value={value || undefined}
            placeholder={field.placeholder}
            options={field.options}
            style={{ minWidth: 180 }}
            onChange={(v) => onChange(v ?? '')}
          />
        );
      case 'password':
        return (
          <Input.Password
            data-testid={testId}
            value={value}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      default:
        return (
          <Input
            data-testid={testId}
            value={value}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        );
    }
  };

  // 长文本类控件占整行宽度（label/desc 在上，控件在下）；开关/数字/下拉走两端对齐行。
  const inline = field.type === 'boolean' || field.type === 'number' || field.type === 'select';

  if (inline) {
    return (
      <div className={styles.row}>
        <div className={styles.meta}>
          <div className={styles.label}>{field.label}</div>
          {field.description ? <div className={styles.desc}>{field.description}</div> : null}
        </div>
        <div className={styles.control}>{control()}</div>
      </div>
    );
  }

  return (
    <Flexbox gap={6} style={{ paddingBlock: 10 }}>
      <div className={styles.label}>{field.label}</div>
      {field.description ? <div className={styles.desc}>{field.description}</div> : null}
      <div className={cx(styles.wide)}>{control()}</div>
    </Flexbox>
  );
}
```

- [ ] **步骤 4：运行测试验证通过**

`cd tauri-agent && npx vitest run src/features/settings/SettingField.test.tsx` — 预期 PASS（4 用例）。

> 注意：antd `Switch`/`Input` 会把 `data-testid` 透传到底层可点击元素；若某控件未透传导致 testid 找不到，用包裹 `<span data-testid>` 兜底，但优先依赖透传。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/settings/SettingField.tsx tauri-agent/src/features/settings/SettingField.test.tsx
git commit -m "feat(settings): rich field controls (switch/number/select) with description"
```

---

# 任务 T3：新增 `SettingCard`

**文件**：新增 `SettingCard.tsx`

- [ ] **步骤 1：实现 `SettingCard.tsx`**

```tsx
import { createStyles } from 'antd-style';
import type { ReactNode } from 'react';

const useStyles = createStyles(({ css, token }) => ({
  card: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorFillQuaternary};
    padding: 16px 20px;
    margin-block-end: 16px;
  `,
  title: css`
    font-size: 14px;
    font-weight: 600;
    color: ${token.colorText};
    margin-block-end: 8px;
  `,
}));

interface Props {
  title?: string;
  children: ReactNode;
}

export function SettingCard({ title, children }: Props) {
  const { styles } = useStyles();
  return (
    <div className={styles.card} data-testid={title ? `set-card-${title}` : 'set-card'}>
      {title ? <div className={styles.title}>{title}</div> : null}
      {children}
    </div>
  );
}
```

- [ ] **步骤 2：类型检查**

`cd tauri-agent && npx tsc --noEmit` — 预期无错误（SettingCard 自洽）。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/features/settings/SettingCard.tsx
git commit -m "feat(settings): add SettingCard container"
```

---

# 任务 T4：`SettingsPanel` 重写（分组导航 + 卡片）

**文件**：重写 `SettingsPanel.tsx`；更新 `SettingsPanel.test.tsx`

- [ ] **步骤 1：更新测试断言**

把 `SettingsPanel.test.tsx` 的 `describe` 体替换为（保留顶部 mock 不变）：

```tsx
describe('SettingsPanel', () => {
  it('renders grouped nav and prefills loaded values', async () => {
    render(<SettingsPanel />);
    await waitFor(() => expect(screen.getByTestId('set-cat-general')).toBeTruthy());
    expect(screen.getByTestId('set-cat-knowledge')).toBeTruthy();
    expect(screen.getByTestId('set-cat-memory')).toBeTruthy();
    // 分组标题
    expect(screen.getByText('能力')).toBeTruthy();
    // general 选中态下，OpenAI Key 预填
    const input = screen.getByTestId('set-field-OPENAI_API_KEY') as HTMLInputElement;
    expect(input.value).toBe('sk-old');
  });

  it('switches category and shows section cards', async () => {
    render(<SettingsPanel />);
    await waitFor(() => expect(screen.getByTestId('set-cat-memory')).toBeTruthy());
    fireEvent.click(screen.getByTestId('set-cat-memory'));
    expect(screen.getByTestId('set-card-记忆召回')).toBeTruthy();
    expect(screen.getByTestId('set-card-记忆维护')).toBeTruthy();
    expect(screen.getByTestId('set-field-MEMORY_AUTO_INJECT')).toBeTruthy();
  });

  it('edits a field and saves', async () => {
    render(<SettingsPanel />);
    await waitFor(() => expect(screen.getByTestId('set-field-OPENAI_API_KEY')).toBeTruthy());
    fireEvent.change(screen.getByTestId('set-field-OPENAI_API_KEY'), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByTestId('set-save'));
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ OPENAI_API_KEY: 'sk-new' })),
    );
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

`cd tauri-agent && npx vitest run src/features/settings/SettingsPanel.test.tsx` — 预期 FAIL（无分组标题 / 无 section 卡）。

- [ ] **步骤 3：重写 `SettingsPanel.tsx`**

整体替换为：

```tsx
import { Flexbox, Icon } from '@lobehub/ui';
import { createStyles } from 'antd-style';
import { useState } from 'react';
import { SETTINGS_SCHEMA, SETTING_GROUPS, type SettingCategory } from './settingsSchema';
import { SettingCard } from './SettingCard';
import { SettingFieldInput } from './SettingField';
import { useSettingsForm } from './useSettingsForm';

const useStyles = createStyles(({ css, token }) => ({
  root: css`
    height: 100%;
    min-height: 0;
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-block-end: 1px solid ${token.colorBorderSecondary};
    flex: 0 0 auto;
  `,
  hint: css`
    font-size: 13px;
    color: ${token.colorTextSecondary};
  `,
  body: css`
    display: flex;
    flex: 1;
    min-height: 0;
  `,
  nav: css`
    width: 220px;
    flex: 0 0 auto;
    border-inline-end: 1px solid ${token.colorBorderSecondary};
    overflow-y: auto;
    padding: 12px 8px;
  `,
  groupTitle: css`
    padding: 12px 12px 4px;
    font-size: 12px;
    color: ${token.colorTextDescription};
  `,
  navItem: css`
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 12px;
    border: none;
    border-radius: ${token.borderRadius}px;
    cursor: pointer;
    text-align: start;
    background: transparent;
    color: ${token.colorTextSecondary};
    font-size: 13px;
    &:hover {
      background: ${token.colorFillTertiary};
    }
  `,
  navItemActive: css`
    background: ${token.colorFillSecondary};
    color: ${token.colorText};
  `,
  content: css`
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 20px 24px;
  `,
  pageTitle: css`
    font-size: 18px;
    font-weight: 600;
    color: ${token.colorText};
    margin-block-end: 16px;
  `,
  inner: css`
    max-width: 720px;
  `,
}));

export function SettingsPanel() {
  const { styles, cx } = useStyles();
  const { values, setValue, save, saving, loading, error } = useSettingsForm();
  const [activeId, setActiveId] = useState(SETTINGS_SCHEMA[0].id);
  const cat: SettingCategory = SETTINGS_SCHEMA.find((c) => c.id === activeId) ?? SETTINGS_SCHEMA[0];
  const sections = cat.sections ?? [{ title: '', fields: cat.fields ?? [] }];

  return (
    <Flexbox className={styles.root} data-testid="settings-panel">
      <div className={styles.header}>
        <span className={styles.hint}>{loading ? '加载中…' : '设置（保存后自动重启 sidecar 生效）'}</span>
        <button data-testid="set-save" onClick={() => void save()} disabled={saving} className={styles.navItem} style={{ width: 'auto' }}>
          {saving ? '保存中…' : '保存并重启'}
        </button>
      </div>
      {error ? <div style={{ padding: '6px 16px', fontSize: 12, color: '#f87171' }}>{error}</div> : null}
      <div className={styles.body}>
        <nav className={styles.nav}>
          {SETTING_GROUPS.map((g) => {
            const items = SETTINGS_SCHEMA.filter((c) => c.group === g);
            if (!items.length) return null;
            return (
              <div key={g}>
                <div className={styles.groupTitle}>{g}</div>
                {items.map((c) => (
                  <button
                    key={c.id}
                    data-testid={`set-cat-${c.id}`}
                    onClick={() => setActiveId(c.id)}
                    className={cx(styles.navItem, c.id === activeId && styles.navItemActive)}
                  >
                    <Icon icon={c.icon} size={16} />
                    {c.title}
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
        <div className={styles.content}>
          <div className={styles.inner}>
            <div className={styles.pageTitle}>{cat.title}</div>
            {sections.map((sec, i) => (
              <SettingCard key={sec.title || i} title={sec.title || undefined}>
                {sec.fields.map((f) => (
                  <SettingFieldInput key={f.key} field={f} value={values[f.key] ?? ''} onChange={(v) => setValue(f.key, v)} />
                ))}
              </SettingCard>
            ))}
          </div>
        </div>
      </div>
    </Flexbox>
  );
}
```

- [ ] **步骤 4：运行测试验证通过**

`cd tauri-agent && npx vitest run src/features/settings/SettingsPanel.test.tsx` — 预期 PASS（3 用例）。

> STOP 条件：若 `set-card-记忆召回` 找不到，确认 `SettingCard` 的 testid 用 `set-card-${title}` 且 memory sections 标题为「记忆召回」「记忆维护」（与 T1 schema 一致）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/settings/SettingsPanel.tsx tauri-agent/src/features/settings/SettingsPanel.test.tsx
git commit -m "feat(settings): grouped icon nav + card layout for settings page"
```

---

# 任务 T5：回归 + 类型 + 构建（验证门）

- [ ] **步骤 1：settings 全量单测**

`cd tauri-agent && npx vitest run src/features/settings/` — 预期全绿（schema + SettingField + SettingsPanel）。

- [ ] **步骤 2：ConnectionsPanel 不回归**

`cd tauri-agent && npx vitest run src/features/connections` （若存在该目录/测试）— 预期 PASS（`SettingFieldInput` 签名/ testid 兼容）。若无测试，手动确认 `ConnectionsPanel` 仍正常 import `SettingFieldInput`。

- [ ] **步骤 3：类型检查**

`cd tauri-agent && npx tsc --noEmit` — 预期无错误。

- [ ] **步骤 4：构建**

`cd tauri-agent && npm run build` — 预期成功（tsc && vite build）。

> STOP 条件：若构建因 `lucide-react` 图标名不存在报错，核对图标名（Settings2/BookOpen/Brain/Image/AudioLines/Globe/Boxes/ShieldCheck 均为 lucide 有效导出）。

- [ ] **步骤 5：无新增 commit（纯验证）**

P 完成 —— 设置页分组导航 + 卡片化 + 控件升级落地。

---

## 自检结果

**1. 规格覆盖度**

| spec 章节 | 任务 | 状态 |
|-----------|------|------|
| §3 导航分组映射 | T1 schema group/icon + T4 导航渲染 | OK |
| §4 schema 增强（类型/字段元数据） | T1 | OK |
| §5 控件映射 | T2 | OK |
| §6 卡片分组（sections） | T1（memory/web sections）+ T3 SettingCard + T4 渲染 | OK |
| §7 组件结构 | T2/T3/T4 | OK |
| §8 不变约束（env/save/key） | 全程未改 useSettingsForm；env key 沿用 | OK |
| §9 测试 | T1/T2/T4 测试 | OK |

**2. 占位符扫描**：无 TODO/待补充；每步含完整可粘贴代码或精确命令。

**3. 契约一致性**：
- testid：`set-cat-{id}`（T4）、`set-field-{key}`/`conn-field-{key}`（T2 默认前缀）、`set-save`（T4）、`set-card-{title}`（T3/T4）一致。
- `SettingFieldInput` 签名 `{ field, value, onChange, testIdPrefix? }` 保持，ConnectionsPanel 复用不破（T5 步骤 2 验证）。
- boolean `'1'/'0'`、number 字符串编码不变（T2）。
- memory sections 标题「记忆召回」「记忆维护」在 T1 定义、T4 测试引用，一致。

**4. 向后兼容**：env key 全部沿用；CONNECTION_FIELDS 仅加可选 description；存储零迁移。

> 刻意记录：`ConnectionsPanel` 复用 `SettingFieldInput`，重写后它会**自动获得新控件样式**（视觉升级、功能不变）；这是预期的连带改进，非破坏（T5 步骤 2 守护）。

---

## 执行交接

计划已保存到 `tauri-agent/docs/superpowers/plans/2026-06-15-settings-redesign-plan.md`，设计见同名 specs。

本仓库**禁止子代理**，**内联执行**：
- **必需子技能**：`superpowers:executing-plans`
- 顺序：T1 → T2 → T3 → T4 → T5，每任务末尾 commit。
- 验证门：T5（settings 全量单测 + ConnectionsPanel 不回归 + tsc + build）。
