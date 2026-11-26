import type { ReactElement } from 'react'
import { App } from 'antd'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { InlineQuestionCard } from '../../src/features/chat/InlineQuestionCard'
import { VisualPanel } from '../../src/features/visual/VisualPanel'
import { useInlineQuestionStore } from '../../src/stores/inlineQuestionStore'
import { parkVisibleUiRequests, restoreStashedUiRequests } from '../../src/stores/backgroundUiRequests'
import { useVisualStore, visualKeyOf } from '../../src/stores/visualStore'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

/** Deterministic UI fixture: only the ask_user card can answer a published preview. */
const WS = '/visual-review-workspace'
const OWNER = { workspace: WS, sessionPath: '/visual-review-workspace/.pi/review.jsonl' }
const KEY = visualKeyOf(OWNER)
const FIRST = 'preview-review-first'
const SECOND = 'preview-review-second'
const THIRD = 'preview-review-third'
const FOURTH = 'preview-review-fourth'

installBridge({
  invoke: async (command: string, args: { response?: { id: string; value?: string; cancelled?: boolean }; draft?: unknown; toolCallId?: string }) => {
    if (command === 'extension_ui_respond') {
      track(`respond:${JSON.stringify(args.response)}`)
      return undefined
    }
    if (command === 'ask_user_draft_write' || command === 'ask_user_draft_delete') return undefined
    throw new Error(`unstubbed invoke: ${command}`)
  },
})

function publish(version: 1 | 2 | 3 | 4): void {
  const previewId = [FIRST, SECOND, THIRD, FOURTH][version - 1]
  useVisualStore.getState().setVisual(OWNER, `<div class="mockup"><h2>第 ${version} 版预览</h2><div class="options"><div class="option" data-choice="a" onclick="toggleSelect(this)">方案 A</div><div class="option" data-choice="b" onclick="toggleSelect(this)">方案 B</div></div></div>`, 'panel', previewId)
  useInlineQuestionStore.getState().setRequest({
    workspace: WS,
    sessionPath: OWNER.sessionPath,
    id: `request-${version}`,
    toolCallId: `call-${version}`,
    mode: 'live',
    data: {
      kind: 'questions', id: `questions-${version}`, visualReview: { previewId },
      allowExtra: true, allowExtraImages: true,
      questions: [
        { id: 'visual-review', title: '这版视觉产出是否通过评审？', options: [{ id: 'approve', label: '通过' }, { id: 'redo', label: '打回重做' }], allowMultiple: false, allowCustom: false },
        { id: 'q1', title: '选用哪个方案？', options: [{ id: 'a', label: '方案 A' }, { id: 'b', label: '方案 B' }, { id: '__custom__', label: '其他（自定义）' }], allowMultiple: false, allowCustom: true },
      ],
    },
  })
}

publish(1)
exposeActions({
  nextVersion: () => publish(2),
  thirdVersion: () => publish(3),
  fourthVersion: () => publish(4),
  park: () => parkVisibleUiRequests(WS, OWNER.sessionPath),
  restore: () => restoreStashedUiRequests(WS, OWNER.sessionPath),
  legacyMessage: () => window.postMessage({ type: 'visual-choice', choice: 'approve', text: '通过' }, '*'),
})
exposeData({ firstPreview: FIRST, secondPreview: SECOND, thirdPreview: THIRD, fourthPreview: FOURTH })

const mockStore = { useStore: (select: (s: { messages: unknown[] }) => unknown) => select({ messages: [] }) } as unknown as AgentStoreApi
const context = { workspace: WS, store: mockStore, workspaceReady: false, setWorkspaceReady: () => {}, appBooted: true }

export default function VisualReviewScenario(): ReactElement {
  return (
    <App>
      <AgentStoreContext.Provider value={context}>
        <div style={{ display: 'flex', height: '100vh', background: 'var(--gren-content-bg)', padding: 24, boxSizing: 'border-box', gap: 24 }}>
          <div style={{ width: 650, minWidth: 0, alignSelf: 'flex-end', maxHeight: '85vh', display: 'flex' }}>
            <InlineQuestionCard />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}><VisualPanel visualKey={KEY} /></div>
        </div>
      </AgentStoreContext.Provider>
    </App>
  )
}
