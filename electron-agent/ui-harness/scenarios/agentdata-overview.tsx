import type { ReactElement } from 'react'
import { OverviewPanel } from '../../src/features/agentData/OverviewPanel'
import { installBridge } from '../stubs'

/**
 * Agent 数据 · 概览：真实 OverviewPanel，数据直接给 props，不走主进程。
 * 三张卡片内容多少不一（任务 4 条、知识库为空、记忆 3 条且正文两行截断），才看得出卡片有没有拉到同高、底边对齐。
 */

installBridge({})

const noop = (): void => {}
// 固定时间，相对时间文案不随运行时刻变（probe 不断言文案）。
const AT = '2026-10-14T00:00:00.000Z'

const tasks = ['代码索引同步', '代码索引同步', '代码索引同步', '记忆原则'].map((label, i) => ({
  key: `task-${i}`,
  label,
  status: 'completed',
  updatedAt: AT,
  ref: { kind: 'job', id: `task-${i}` },
}))

const recentMemories = [
  '# Team Operating Doctrine > **Operating Thesis**: 沟通与交付的本质是让对方能准确判断状态并接力下去，所以每次交付都要写清楚做了什么、没做什么、下一步是谁。',
  '-----META-START----- created: 2026-10-06T10:06:11.643Z updated: 2026-10-06T10:06:11.643Z source: conversation tags: workflow',
  '{"content":"在向他人提出请求并设定截止时间时，英语表达可用 Could you take a look before Thursday? 这样既礼貌又明确。"}',
].map((content, i) => ({ id: `mem-${i}`, content, level: 3 - i, scope: i === 2 ? 'project' : 'global', sourceProjectId: i === 2 ? 'D:/work/08ba2860' : undefined, updatedAt: AT }))

export default function AgentDataOverviewScenario(): ReactElement {
  return (
    <div style={{ height: '100vh', boxSizing: 'border-box', overflow: 'auto', padding: 24, background: 'var(--gren-content-bg)' }}>
      <OverviewPanel
        memory={{ loading: false, data: { total: 630, byLevel: { L0: 0, L1: 611, L2: 18, L3: 1 } } }}
        workbench={{ loading: false, data: { recentPages: [], recentMemories, errors: [], libraries: { total: 0, pages: 0 }, activeTasks: 0, failedTasks: 195 } as never }}
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
