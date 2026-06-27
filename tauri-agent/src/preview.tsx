import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { m } from 'motion/react';
import { Bot, Boxes } from 'lucide-react';
import { ThemeBridge } from './components/ThemeBridge';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToolExecution } from './features/tools/ToolExecution';
import { ReasoningInline } from './features/chat/ReasoningInline';
import { NoticePill } from './features/chat/NoticePill';
import { UserMessage } from './features/chat/UserMessage';
import { CodeSurface, ConvCard, ConvRow, ConvStrip, MutedLine, OptionRow } from './features/chat/conv';
import './index.css';

/** 对话项「真实渲染」预览沙盒：用真实主题 + 真实组件渲染，专供风格统一化评估。不连后端。 */

const toolResult = (text: string) => ({ content: [{ type: 'text', text }] });

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', fontFamily: 'ui-monospace, monospace' }}>
        {label}
      </div>
      <ErrorBoundary>{children}</ErrorBoundary>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 36 }}>
      <h2 style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: 0, paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        {title}
      </h2>
      {children}
    </div>
  );
}

function Gallery() {
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '28px 22px 80px' }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, color: 'rgba(255,255,255,0.88)', margin: '0 0 4px' }}>
        对话项 · 真实渲染基线
      </h1>
      <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)', margin: '0 0 28px' }}>
        用真实主题与真实组件渲染（非手画原型）。这是统一化的「现状」，对照它在终端告诉我要往哪调。
      </p>

      <Section title="conv 基元（统一视觉系统）">
        <Item label="ConvRow（L2 纯行：done / running / error + 展开 CodeSurface）">
          <ConvRow status="done" icon={Boxes} name="read" args="agents.ts" meta="+52" open onToggle={() => {}} body={<CodeSurface>{'export function withBuiltinDefaults() {}'}</CodeSurface>} />
          <ConvRow status="running" icon={Boxes} name="edit" args="memory-file.ts" meta="运行中…" />
          <ConvRow status="error" icon={Boxes} name="bash" args="npm test" meta="出错" />
        </Item>
        <Item label="ConvStrip（L3 横条：子代理）">
          <ConvStrip status="done" icon={Bot} title="子代理" num="#1" chip="审查刚才的改动" meta="完成 · 6 步" onToggle={() => {}} />
        </Item>
        <Item label="MutedLine（L1 低调行：思考 / 注入）">
          <MutedLine icon={Boxes} text="已深度思考 · 13 秒" onToggle={() => {}} />
        </Item>
        <Item label="ConvCard + OptionRow（L4 卡片：ask_user）">
          <ConvCard
            label="需要你确认"
            icon={Bot}
            tag="ask_user"
            footer={
              <>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>单选</span>
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>提交</span>
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

      <Section title="用户消息">
        <Item label="UserMessage">
          <UserMessage text="把所有渲染对话项做风格统一化设计定制" />
        </Item>
      </Section>

      <Section title="思考段 ReasoningInline">
        <Item label="status=done · durationMs=13200">
          <ReasoningInline content={'先盘点所有对话项，再抽共享基元与设计 token。\n\n- 工具卡\n- 子代理\n- notice'} streaming={false} durationMs={13200} />
        </Item>
        <Item label="status=streaming">
          <ReasoningInline content={'正在比较三种状态表达方式的视觉密度…'} streaming durationMs={undefined} />
        </Item>
      </Section>

      <Section title="注入提示 NoticePill">
        <Item label="long-term-memory">
          <NoticePill customType="long-term-memory" content={'## 已注入长期记忆\n- 项目用 bun 跑脚本\n- 默认分支 main\n- 不使用 emoji'} />
        </Item>
      </Section>

      <Section title="工具卡 ToolExecution">
        <Item label="read · done">
          <ToolExecution toolName="read" args={{ path: 'extensions/multi-agent/agents.ts' }} result={toolResult('export function withBuiltinDefaults(discovered) {\n  // union built-in defaults\n  return merged;\n}')} status="done" />
        </Item>
        <Item label="bash · done">
          <ToolExecution toolName="bash" args={{ command: 'npx vitest run multi-agent/' }} result={toolResult('Test Files  8 passed | 1 skipped\n     Tests  88 passed | 2 skipped')} status="done" />
        </Item>
        <Item label="write · done">
          <ToolExecution toolName="write" args={{ path: 'tauri-agent/src/features/dock/SubAgentLogBody.tsx', content: 'export function SubAgentLogBody({ tab }) {\n  return <SubAgentConversation />;\n}' }} result={toolResult('')} status="done" />
        </Item>
        <Item label="bash · error">
          <ToolExecution toolName="bash" args={{ command: 'npm test' }} result={toolResult('Error: worker agent unavailable')} status="error" />
        </Item>
        <Item label="memory_save · running">
          <ToolExecution toolName="memory_save" args={{ text: '统一卡片基元' }} result={undefined} status="running" />
        </Item>
      </Section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider themeMode="dark" theme={{ cssVar: {}, hashed: false }}>
      <ConfigProvider motion={m}>
        <ThemeBridge />
        <Gallery />
      </ConfigProvider>
    </ThemeProvider>
  </StrictMode>,
);
