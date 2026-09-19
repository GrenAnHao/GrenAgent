import { StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { m } from 'motion/react';
import { Bot, Boxes, FilePen, FileText, Moon, Sparkles, Sun, Terminal } from 'lucide-react';
import { ANTD_CSS_VAR_KEY, ThemeBridge } from './components/ThemeBridge';
import { schemePrimary, schemeTokens } from './theme/colorSchemes';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToolExecution } from './features/tools/ToolExecution';
import { renderExtensionCard } from './features/tools/extensionCards';
import { AnsweredQuestionsCard } from './features/tools/AnsweredQuestionsCard';
import { ReasoningInline } from './features/chat/ReasoningInline';
import { NoticePill } from './features/chat/NoticePill';
import { UserMessage } from './features/chat/UserMessage';
import { PlanCard } from './features/chat/PlanCard';
import { SubAgentInline } from './features/chat/SubAgentInline';
import { AttachmentCard } from './features/chat/AttachmentCard';
import { TodoDock } from './features/chat/input/TodoDock';
import { CodeSurface, ConvCard, ConvRow, ConvStrip, MutedLine, OptionRow, StatusGlyph } from './features/chat/conv';
import { AgentStoreContext } from './stores/AgentStoreContext';
import type { AgentStoreApi } from './stores/agent';
import './index.css';

/**
 * 对话项「真实渲染」预览沙盒（视觉伴侣）：用真实主题 + 真实组件渲染每一类对话控件的每一种状态，
 * 专供风格统一化评估。不连后端——依赖 workspace 的控件用下方 mock AgentStoreContext 注入；
 * 媒体类卡（生成图片 / 语音）在无 Tauri 环境只能渲染加载态，已就近标注。
 */

// 注入一个不连后端的 store 上下文：渲染期这些控件只读 workspace 字符串；workspaceReady=false
// 让 ModelAction 等跳过后端调用。store 不会在渲染期被解引用，给个占位即可。
const mockAgentCtx = {
  workspace: 'preview',
  store: {} as unknown as AgentStoreApi,
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true,
};

const toolResult = (text: string) => ({ content: [{ type: 'text', text }] });
const withDetails = (details: Record<string, unknown>, text = '') => ({
  content: text ? [{ type: 'text', text }] : [],
  details,
});

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--gren-fg-muted)', opacity: 0.7, fontFamily: 'ui-monospace, monospace' }}>
        {label}
      </div>
      <ErrorBoundary>{children}</ErrorBoundary>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 40 }}>
      <h2
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--gren-fg-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          margin: 0,
          paddingBottom: 8,
          borderBottom: '1px solid var(--gren-border)',
        }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

const plan = JSON.stringify({
  kind: 'plan',
  id: 'p1',
  title: '统一对话控件视觉系统',
  summary: '抽出共享基元 conv/*，把工具卡、子代理、问答、待办都收敛到统一 surface + token。',
  todos: [
    { text: '抽 ConvRow / ConvCard / ConvStrip 基元', done: true },
    { text: '迁移通用工具卡到 ConvRow', done: true },
    { text: 'TodoCard 卡头对齐 ConvCard', done: false },
    { text: '回归测试 + 预览验收', done: false },
  ],
  planFile: 'docs/plan.md',
  status: 'draft',
});

const webResults = [
  { title: 'antd-style createStaticStyles 零运行时样式', url: 'https://ant-design.github.io/antd-style/', snippet: '用 cssVar 变量编写静态样式，切主题不重渲染组件。' },
  { title: 'CSS-in-JS 性能对比', url: 'https://example.com/css-in-js', snippet: '静态提取 vs 运行时计算的取舍与基准测试。' },
  { title: 'lobehub/ui 组件库', url: 'https://ui.lobehub.com', snippet: 'base-ui 无头基元优先，root 次之，antd 兜底。' },
];

function Gallery() {
  return (
    <div style={{ maxWidth: 780, margin: '0 auto', padding: '28px 22px 96px' }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--gren-fg)', margin: '0 0 4px' }}>
        对话控件 · 真实渲染基线
      </h1>
      <p style={{ fontSize: 13, color: 'var(--gren-fg-muted)', margin: '0 0 28px' }}>
        用真实主题与真实组件渲染（非手画原型）。这是统一化的「现状」，对照它告诉我要往哪调。
      </p>

      <Section title="conv 基元（统一视觉系统）">
        <Item label="StatusGlyph（行首状态：running / done / error）">
          <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--gren-fg-muted)' }}>
              <StatusGlyph status="running" /> running
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--gren-fg-muted)' }}>
              <StatusGlyph status="done" /> done
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--gren-fg-muted)' }}>
              <StatusGlyph status="error" /> error
            </span>
          </div>
        </Item>
        <Item label="ConvRow（L2 纯行：done 展开 / done 折叠 / running / error）">
          <ConvRow status="done" icon={FileText} name="read" args="agents.ts" meta="+52" open onToggle={() => {}} body={<CodeSurface>{'export function withBuiltinDefaults() {}'}</CodeSurface>} />
          <ConvRow status="done" icon={FilePen} name="edit" args="memory-file.ts" meta="+8 -3" body={<CodeSurface>{'noop'}</CodeSurface>} onToggle={() => {}} />
          <ConvRow status="running" icon={FilePen} name="edit" args="runner.ts" meta="运行中…" />
          <ConvRow status="error" icon={Terminal} name="bash" args="npm test" meta="出错" />
        </Item>
        <Item label="ConvStrip（L3 横条：子代理 done / running / error）">
          <ConvStrip status="done" icon={Bot} title="子代理 #1" role="性能工程师" model="deepseek-v4-flash" line2="已完成 · 6 步 · 12.3k · 审查刚才的改动" onToggle={() => {}} />
          <ConvStrip status="running" icon={Bot} title="子代理 #2" role="测试工程师" model="gpt-5.3-codex" line2="第 3 步 · 调用 read_file" onStop={() => {}} onToggle={() => {}} />
          <ConvStrip status="error" icon={Bot} title="子代理 #3" role="构建工程师" model="claude-4.6-sonnet" line2="出错 · 3 步 · 构建 sidecar 失败" onToggle={() => {}} />
        </Item>
        <Item label="MutedLine（L1 低调行：深度思考 / 注入计数）">
          <MutedLine icon={Boxes} text="已深度思考 · 13 秒" onToggle={() => {}} />
          <MutedLine icon={Sparkles} text="已注入长期记忆" count={3} onToggle={() => {}} />
        </Item>
        <Item label="ConvCard + OptionRow（L4 卡片：ask_user 询问态）">
          <ConvCard
            label="需要你确认"
            icon={Bot}
            tag="ask_user"
            footer={
              <>
                <span style={{ fontSize: 11, color: 'var(--gren-fg-muted)' }}>单选</span>
                <span style={{ fontSize: 12, color: 'var(--gren-fg)' }}>提交</span>
              </>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 8 }}>
              <OptionRow index={1} label="三者都要，以共享基元 + token 为底" selected recommended onClick={() => {}} />
              <OptionRow index={2} label="只要视觉一致" selected={false} onClick={() => {}} />
            </div>
          </ConvCard>
        </Item>
      </Section>

      <Section title="用户消息 UserMessage">
        <Item label="纯文本">
          <UserMessage text="把所有渲染对话项做风格统一化设计定制" />
        </Item>
        <Item label="带附件块（粘贴文本）">
          <UserMessage text={'看下这段日志为啥报错\n<pi:attachment type="text" lines="3" chars="86">\nError: worker agent unavailable\n  at spawn (runner.ts:42)\n  at tick (loop.ts:11)\n</pi:attachment>'} />
        </Item>
      </Section>

      <Section title="思考段 ReasoningInline">
        <Item label="done · durationMs=13200">
          <ReasoningInline content={'先盘点所有对话项，再抽共享基元与设计 token。\n\n- 工具卡\n- 子代理\n- notice'} streaming={false} durationMs={13200} />
        </Item>
        <Item label="streaming">
          <ReasoningInline content={'正在比较三种状态表达方式的视觉密度…'} streaming durationMs={undefined} />
        </Item>
      </Section>

      <Section title="注入提示 NoticePill">
        <Item label="上下文注入（可展开）">
          <NoticePill customType="context" content={'## 已注入上下文\n- 项目约定\n- 当前任务状态'} />
        </Item>
      </Section>

      <Section title="工具行 ToolExecution（通用工具 · ConvRow）">
        <Item label="read SKILL.md → 使用技能 · done">
          <ToolExecution toolName="read" args={{ path: '.claude/skills/tdd/SKILL.md' }} result={toolResult('# TDD\nred-green-refactor')} status="done" />
        </Item>
        <Item label="bash · done">
          <ToolExecution toolName="bash" args={{ command: 'npx vitest run multi-agent/', description: 'Run multi-agent tests' }} result={toolResult('Test Files  8 passed | 1 skipped\n     Tests  88 passed | 2 skipped')} status="done" />
        </Item>
        <Item label="bash · error">
          <ToolExecution toolName="bash" args={{ command: 'npm test', description: 'Run package tests' }} result={toolResult('Error: worker agent unavailable')} status="error" />
        </Item>
        <Item label="write · done">
          <ToolExecution toolName="write" args={{ path: 'src/features/dock/SubAgentLogBody.tsx', content: 'export function SubAgentLogBody() {\n  return null;\n}' }} result={toolResult('')} status="done" />
        </Item>
        <Item label="edit（diff）· done">
          <ToolExecution toolName="edit" args={{ path: 'src/features/tools/extensionCards.tsx' }} result={withDetails({ diff: '--- a/extensionCards.tsx\n+++ b/extensionCards.tsx\n@@\n-  font-weight: 500;\n+  font-weight: 600;' })} status="done" />
        </Item>
        <Item label="bash · running（自动展开）">
          <ToolExecution toolName="bash" args={{ command: 'npm run build', description: 'Build the package' }} result={undefined} status="running" />
        </Item>
      </Section>

      <Section title="待办（dock 条 + 对话流行）">
        <Item label="任务条 · 并行进行中">
          <TodoDock
            todos={[
              { id: 1, text: '搭骨架', status: 'completed' },
              { id: 2, text: '写组件', status: 'in_progress' },
              { id: 3, text: '跑后台构建', status: 'in_progress' },
            ]}
          />
        </Item>
        <Item label="对话流 · 并行进行中">
          <ToolExecution
            toolName="todo"
            args={{}}
            result={withDetails({
              todos: [
                { id: 1, text: '搭骨架', status: 'completed' },
                { id: 2, text: '写组件', status: 'in_progress' },
                { id: 3, text: '跑后台构建', status: 'in_progress' },
              ],
              nextId: 4,
            })}
            status="done"
          />
        </Item>
      </Section>

      <Section title="计划卡 PlanCard（L4 ConvCard surface）">
        <Item label="draft · 标题 + 摘要 + todo 预览 + 页脚">
          <PlanCard content={plan} />
        </Item>
      </Section>

      <Section title="检索 / 抓取卡">
        <Item label="web_search · done（可展开，favicon 叠展）">
          {renderExtensionCard({ toolName: 'web_search', args: { query: 'antd-style createStaticStyles' }, result: withDetails({ query: 'antd-style createStaticStyles', provider: 'duckduckgo', results: webResults }), status: 'done' })}
        </Item>
        <Item label="web_search · running（骨架）">
          {renderExtensionCard({ toolName: 'web_search', args: { query: 'css-in-js benchmark' }, result: undefined, status: 'running' })}
        </Item>
        <Item label="web_search · 空结果">
          {renderExtensionCard({ toolName: 'web_search', args: { query: 'zzz-no-hit' }, result: withDetails({ query: 'zzz-no-hit', results: [] }), status: 'done' })}
        </Item>
        <Item label="search · 多引擎聚合">
          {renderExtensionCard({ toolName: 'search', args: { query: 'react 19 use hook' }, result: withDetails({ query: 'react 19 use hook', engines: ['bing', 'duckduckgo'], results: webResults.slice(0, 2) }), status: 'done' })}
        </Item>
        <Item label="fetch_url · done（卡片可点开右坞）">
          {renderExtensionCard({ toolName: 'fetch_url', args: { url: 'https://ui.lobehub.com' }, result: withDetails({ url: 'https://ui.lobehub.com', title: 'LobeHub UI 组件库', chars: 5234, crawler: 'jina' }, '一套 React 组件、合理的 UI 设计与友好的开发体验。base-ui 无头基元优先。'), status: 'done' })}
        </Item>
        <Item label="fetch_url · loading">
          {renderExtensionCard({ toolName: 'fetch_url', args: { url: 'https://example.com/slow' }, result: undefined, status: 'running' })}
        </Item>
        <Item label="fetch_url · error">
          {renderExtensionCard({ toolName: 'fetch_url', args: { url: 'https://example.com/down' }, result: withDetails({ url: 'https://example.com/down', error: '抓取失败：连接超时' }), status: 'error' })}
        </Item>
        <Item label="fetch_csdn_article · done">
          {renderExtensionCard({ toolName: 'fetch_csdn_article', args: { url: 'https://blog.csdn.net/x/article/details/123' }, result: withDetails({ url: 'https://blog.csdn.net/x/article/details/123', chars: 1820 }, 'antd-style 实战：用 createStaticStyles 把运行时样式改成零运行时…'), status: 'done' })}
        </Item>
      </Section>

      <Section title="扩展卡 ExtensionCards">
        <Item label="spawn_agent">
          {renderExtensionCard({ toolName: 'spawn_agent', args: {}, result: withDetails({ count: 3, failed: 0 }, '3 个子代理已派发'), status: 'done' })}
        </Item>
        <Item label="generate_image · running（无 Tauri 仅加载态）">
          {renderExtensionCard({ toolName: 'generate_image', args: { prompt: '一只在键盘上打字的橘猫，扁平插画' }, result: undefined, status: 'running' })}
        </Item>
        <Item label="speak · running（无 Tauri 仅加载态）">
          {renderExtensionCard({ toolName: 'speak', args: { text: '风格统一化已完成，待你验收。' }, result: undefined, status: 'running' })}
        </Item>
      </Section>

      <Section title="问答 ask_user · 已回答 AnsweredQuestionsCard">
        <Item label="单题">
          <AnsweredQuestionsCard
            args={{ questions: [{ question: '采用哪种统一策略？', options: [{ label: '共享基元+token' }, { label: '仅视觉一致' }, { label: '完全重写' }] }] }}
            result={toolResult('[我的选择]\n1. 采用哪种统一策略？：共享基元+token')}
          />
        </Item>
        <Item label="多题（可展开）">
          <AnsweredQuestionsCard
            args={{ questions: [
              { question: '卡头是否对齐 ConvCard？', options: [{ label: '对齐' }, { label: '保持现状' }] },
              { question: '图标族是否统一？', options: [{ label: '统一为 CircleCheck' }, { label: '不变' }] },
            ] }}
            result={toolResult('[我的选择]\n1. 卡头是否对齐 ConvCard？：对齐\n2. 图标族是否统一？：统一为 CircleCheck')}
          />
        </Item>
      </Section>

      <Section title="子代理内联 SubAgentInline（L3 横条 + 展开体）">
        <Item label="done">
          <SubAgentInline messageId="m1" toolCallId="t1" index={1} task="审查刚才的改动" result={toolResult('已审查，未发现回归。')} status="done" />
        </Item>
        <Item label="running">
          <SubAgentInline messageId="m2" toolCallId="t2" index={2} task="跑全量测试" result={undefined} status="running" />
        </Item>
        <Item label="error">
          <SubAgentInline messageId="m3" toolCallId="t3" index={3} task="构建 sidecar" result={toolResult('构建失败：缺少 toolchain')} status="error" />
        </Item>
      </Section>

      <Section title="附件卡 AttachmentCard">
        <Item label="文件块">
          <AttachmentCard block={{ attType: 'file', path: 'src/features/tools/extensionCards.tsx', lines: 1380, content: 'const TodoCard: FC<ExtensionCardProps> = ({ result }) => { /* ... */ };' }} />
        </Item>
        <Item label="文本块">
          <AttachmentCard block={{ attType: 'text', lines: 3, chars: 86, content: 'Error: worker agent unavailable\n  at spawn (runner.ts:42)\n  at tick (loop.ts:11)' }} />
        </Item>
      </Section>
    </div>
  );
}

function Root() {
  const [dark, setDark] = useState(true);
  return (
    <ThemeProvider
      themeMode={dark ? 'dark' : 'light'}
      appearance={dark ? 'dark' : 'light'}
      customTheme={{ primaryColor: schemePrimary('github', dark) }}
      theme={{
        cssVar: { key: ANTD_CSS_VAR_KEY },
        hashed: false,
        token: schemeTokens('github', dark),
      }}
    >
      <ConfigProvider motion={m}>
        <ThemeBridge />
        <button
          type="button"
          onClick={() => setDark((v) => !v)}
          style={{
            position: 'fixed',
            top: 14,
            right: 16,
            zIndex: 10,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            border: '1px solid var(--gren-border)',
            borderRadius: 8,
            background: 'var(--gren-bg-1)',
            color: 'var(--gren-fg)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          {dark ? <Sun size={14} /> : <Moon size={14} />}
          {dark ? '浅色' : '深色'}
        </button>
        <AgentStoreContext.Provider value={mockAgentCtx}>
          <Gallery />
        </AgentStoreContext.Provider>
      </ConfigProvider>
    </ThemeProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
