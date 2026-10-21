import type { ReactElement } from 'react'
import { SessionItem } from '../../src/features/sessions/SessionItem'
import { ProjectItem } from '../../src/features/sessions/ProjectItem'
import { SidebarSectionHeader } from '../../src/features/sessions/SidebarSectionHeader'
import { useAttentionStore } from '../../src/stores/sessionAttention'
import { sessionControlKey } from '../../src/stores/modeStore'
import { attentionTooltip, type AttentionKind, type SessionAttentionState } from '../../src/stores/attentionView'
import { exposeData, installBridge, track } from '../stubs'

/**
 * 侧栏会话行：真实 SessionItem / ProjectItem，行里的回调只记成事件（open:<行>），不需要主进程的命令。
 * 一行运行中（转圈）、一行空闲，标题都长到会被省略号截断，才看得出悬停时标题有没有被挤动。
 * 下面五行各带一种注意状态（审批那行同时在跑，验证角标压过转圈），两个分组头一个折叠、一个展开。
 * Tooltip 文案用真实的 attentionTooltip 现算，期望值经 exposeData 交给 probe。
 */

installBridge({})

const TITLE = '先生成计划然后使用 deepseek 的模型把整个订单查询栏重构一遍并补齐测试'
// 超过 60 字，Tooltip 要截断
const LONG_ERROR =
  '供应商返回 429：请求过于频繁，当前组织的每分钟令牌额度已经用完，请稍后重试或者在控制台里申请提高额度上限，并检查是否有别的任务同时在消耗同一个密钥'

const P = 'D:/repo/.pi/s.jsonl'
const STATES: Record<AttentionKind, SessionAttentionState> = {
  approval: { pending: { path: P, workspace: 'D:/repo', kind: 'approval', title: '执行 npm publish？' } },
  choice: { pending: { path: P, workspace: 'D:/repo', kind: 'choice', title: '用哪个方案重构查询栏？' } },
  failed: { unread: { path: P, workspace: 'D:/repo', outcome: { kind: 'failed', message: LONG_ERROR, seq: 1 } } },
  blocked: { unread: { path: P, workspace: 'D:/repo', blocked: { message: '缺少 STRIPE_API_KEY' } } },
  done: { unread: { path: P, workspace: 'D:/repo', outcome: { kind: 'done', seq: 1 } } },
}
const TOOLTIPS = Object.fromEntries(
  (Object.keys(STATES) as AttentionKind[]).map((kind) => [kind, attentionTooltip(kind, STATES[kind])]),
) as Record<AttentionKind, string>

exposeData({ tooltips: TOOLTIPS })

// 收起的分区里藏着两个需要处理的会话：区头的汇总从真实的 sessionAttention store 算。
const HIDDEN = ['D:/repo/.pi/hidden-1.jsonl', 'D:/repo/.pi/hidden-2.jsonl']
useAttentionStore.setState({
  pending: { [sessionControlKey(HIDDEN[0])]: { path: HIDDEN[0], workspace: 'D:/repo', kind: 'choice', title: '选哪个方案？' } },
  unread: { [sessionControlKey(HIDDEN[1])]: { path: HIDDEN[1], workspace: 'D:/repo', outcome: { kind: 'failed', seq: 1 } } },
})
const NO_RUNNING = new Set<string>()

const noop = (): void => {}

function Row({ id, running, attention }: { id: string; running: boolean; attention?: AttentionKind }): ReactElement {
  return (
    <div data-testid={id}>
      <SessionItem
        title={TITLE}
        active={false}
        running={running}
        {...(attention ? { attention: { kind: attention, tooltip: TOOLTIPS[attention] } } : {})}
        pinned={false}
        onClick={() => track(`open:${id}`)}
        onPinToggle={noop}
        onRequestRename={noop}
        onRename={noop}
        onDelete={noop}
      />
    </div>
  )
}

function Project({ id, expanded }: { id: string; expanded: boolean }): ReactElement {
  return (
    <div data-testid={id}>
      <ProjectItem
        name="order-service"
        expanded={expanded}
        pinned={false}
        attention={{ kind: 'approval', count: 2 }}
        onToggle={noop}
        onNew={noop}
        onPinToggle={noop}
        onReveal={noop}
        onRename={noop}
        onHide={noop}
        onClearSessions={noop}
        onRemove={noop}
      />
    </div>
  )
}

export default function SessionRowScenario(): ReactElement {
  return (
    <div style={{ height: '100vh', boxSizing: 'border-box', padding: 24, background: 'var(--gren-content-bg)' }}>
      {/* 侧栏默认宽度 */}
      <div style={{ width: 240 }}>
        <Row id="running-row" running />
        <Row id="idle-row" running={false} />
        <Row id="approval-row" running attention="approval" />
        <Row id="choice-row" running={false} attention="choice" />
        <Row id="failed-row" running={false} attention="failed" />
        <Row id="blocked-row" running={false} attention="blocked" />
        <Row id="done-row" running={false} attention="done" />
        <Project id="collapsed-project" expanded={false} />
        <Project id="expanded-project" expanded />
        <div data-testid="collapsed-section">
          <SidebarSectionHeader id="projects" label="项目" collapsed onToggle={noop} sessionPaths={HIDDEN} runningSessionPaths={NO_RUNNING} />
        </div>
        <div data-testid="expanded-section">
          <SidebarSectionHeader id="conversations" label="对话" collapsed={false} onToggle={noop} sessionPaths={HIDDEN} runningSessionPaths={NO_RUNNING} />
        </div>
      </div>
    </div>
  )
}
