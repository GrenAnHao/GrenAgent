import type { ReactElement } from 'react'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import type { AgentStoreApi } from '../../src/stores/agent'
import { applyEvent, initialAgentState, messagesFromAgent, type ChatMessage } from '../../src/stores/agentReducer'
import { groupMessages } from '../../src/features/chat/groupMessages'
import { TurnTimeline } from '../../src/features/chat/TurnTimeline'
import { exposeData, installBridge } from '../stubs'
import type { AgentEvent, AgentMessage } from '../../src/lib/pi'

/**
 * Malformed tool arguments (pi 1.3.0): pi-ai's parseToolCallArguments leaves `arguments` as `{}` and
 * sets `argumentsError`; validateToolArguments then throws, and agent-core ends the call with that
 * message as the error result. The text below is exactly what pi 1.3.0 produced for RAW_BASH
 * (checked with parseToolCallArguments + validateToolArguments).
 * Cases go through the real reducer -> groupMessages -> TurnTimeline:
 * live bash, history (get_messages) bash with argumentsError on the toolCall, live MCP tool,
 * and an ordinary bash failure that must keep the bash card.
 */

const RAW_BASH = '{"command": "echo hi", "timeout": 5,}'
const REASON_BASH = 'Expected double-quoted property name in JSON at position 36 (line 1 column 37)'
const RAW_MCP = '{"component": "Splitter"'
const REASON_MCP = "Expected ',' or '}' after property value in JSON at position 24 (line 1 column 25)"

function invalidText(tool: string, reason: string, raw: string): string {
  return `Invalid arguments for tool "${tool}": ${reason}\n\nReceived arguments:\n${raw}`
}

installBridge({})
exposeData({
  cases: ['live-bash', 'history-bash', 'live-mcp', 'ordinary-failure'],
  rawBash: RAW_BASH,
  reasonBash: REASON_BASH,
  rawMcp: RAW_MCP
})

const mockCtx = {
  workspace: 'ui-harness',
  store: {} as unknown as AgentStoreApi,
  workspaceReady: false,
  setWorkspaceReady: () => {},
  appBooted: true
}

function errorResult(text: string): unknown {
  return { content: [{ type: 'text', text }], details: {} }
}

function live(toolCallId: string, toolName: string, text: string, args: unknown = {}): AgentEvent[] {
  return [
    { type: 'tool_execution_start', toolCallId, toolName, args },
    { type: 'tool_execution_end', toolCallId, toolName, result: errorResult(text), isError: true }
  ]
}

function replay(events: AgentEvent[]): ChatMessage[] {
  return events.reduce((state, event) => applyEvent(state, event), initialAgentState()).messages
}

function historyBash(): AgentMessage[] {
  const id = 'bad-args-hist'
  return [
    { role: 'user', content: [{ type: 'text', text: 'run it' }], timestamp: 1 },
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id,
          name: 'bash',
          arguments: {},
          argumentsError: `${REASON_BASH}\n\nReceived arguments:\n${RAW_BASH}`
        }
      ],
      timestamp: 2
    } as unknown as AgentMessage,
    {
      role: 'toolResult',
      toolCallId: id,
      toolName: 'bash',
      content: [{ type: 'text', text: invalidText('bash', REASON_BASH, RAW_BASH) }],
      isError: true,
      timestamp: 3
    }
  ]
}

const CASES: { id: string; title: string; messages: ChatMessage[] }[] = [
  { id: 'live-bash', title: '实时 · bash 参数不是 JSON', messages: replay(live('bad-args-live', 'bash', invalidText('bash', REASON_BASH, RAW_BASH))) },
  { id: 'history-bash', title: '历史回放 · bash', messages: messagesFromAgent(historyBash()) },
  {
    id: 'live-mcp',
    title: '实时 · MCP 工具',
    messages: replay(live('bad-args-mcp', 'mcp__antd__antd_doc', invalidText('mcp__antd__antd_doc', REASON_MCP, RAW_MCP)))
  },
  {
    id: 'ordinary-failure',
    title: '对照 · 普通失败',
    messages: replay(live('plain-fail', 'bash', 'Command exited with code 1', { command: 'false' }))
  }
]

function Turns({ messages }: { messages: ChatMessage[] }): ReactElement {
  return (
    <>
      {groupMessages(messages).map((item) =>
        item.kind === 'turn' ? <TurnTimeline key={item.id} segments={item.segments} /> : null
      )}
    </>
  )
}

export default function InvalidArgumentsCard(): ReactElement {
  return (
    <AgentStoreContext.Provider value={mockCtx}>
      <div
        style={{
          boxSizing: 'border-box',
          height: '100vh',
          overflow: 'auto',
          padding: '20px 24px 80px',
          background: 'var(--gren-content-bg)'
        }}
        className="harness-scroll"
      >
        <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 28 }}>
          {CASES.map((c) => (
            <section key={c.id} data-case={c.id}>
              <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6, color: 'var(--gren-fg-muted)' }}>{c.title}</div>
              <Turns messages={c.messages} />
            </section>
          ))}
        </div>
      </div>
    </AgentStoreContext.Provider>
  )
}
