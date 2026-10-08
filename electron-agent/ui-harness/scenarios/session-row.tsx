import type { ReactElement } from 'react'
import { SessionItem } from '../../src/features/sessions/SessionItem'
import { installBridge, track } from '../stubs'

/**
 * 侧栏会话行：真实 SessionItem，行里的回调只记成事件（open:<行>），不需要主进程的命令。
 * 一行运行中（转圈）、一行空闲，标题都长到会被省略号截断，才看得出悬停时标题有没有被挤动。
 */

installBridge({})

const TITLE = '先生成计划然后使用 deepseek 的模型把整个订单查询栏重构一遍并补齐测试'

const noop = (): void => {}

function Row({ id, running }: { id: string; running: boolean }): ReactElement {
  return (
    <div data-testid={id}>
      <SessionItem
        title={TITLE}
        active={false}
        running={running}
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

export default function SessionRowScenario(): ReactElement {
  return (
    <div style={{ height: '100vh', boxSizing: 'border-box', padding: 24, background: 'var(--gren-content-bg)' }}>
      {/* 侧栏默认宽度 */}
      <div style={{ width: 240 }}>
        <Row id="running-row" running />
        <Row id="idle-row" running={false} />
      </div>
    </div>
  )
}
