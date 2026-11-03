import type { ReactElement } from 'react'
import { OverviewPanel } from '../../src/features/agentData/OverviewPanel'
import { installBridge } from '../stubs'

/**
 * Agent 数据 · 概览：真实 OverviewPanel，数据直接给 props，不走主进程。
 * 两张卡片内容多少不一（任务 4 条、知识库为空），才看得出卡片有没有拉到同高、底边对齐。
 */

installBridge({})

const noop = (): void => {}
// 固定时间，相对时间文案不随运行时刻变（probe 不断言文案）。
const AT = '2026-10-14T00:00:00.000Z'

const tasks = ['代码索引同步', '代码索引同步', '代码索引同步', 'Wiki 页面生成'].map((label, i) => ({
  key: `task-${i}`,
  label,
  status: 'completed',
  updatedAt: AT,
  ref: { kind: 'job', id: `task-${i}` },
}))

export default function AgentDataOverviewScenario(): ReactElement {
  return (
    <div style={{ height: '100vh', boxSizing: 'border-box', overflow: 'auto', padding: 24, background: 'var(--gren-content-bg)' }}>
      <OverviewPanel
        workbench={{ loading: false, data: { recentPages: [], errors: [], libraries: { total: 0, pages: 0 }, activeTasks: 0, failedTasks: 195 } as never }}
        libraries={{ loading: false, data: [] }}
        codeProjects={{ loading: false, data: [] }}
        tasks={tasks as never}
        tasksLoaded
        onNavigate={noop}
        onOpenResource={noop}
      />
    </div>
  )
}
