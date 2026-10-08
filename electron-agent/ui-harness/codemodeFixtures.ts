/**
 * codemode 卡片场景的假数据：按 pi 1.0.2 真实的事件 / 消息形状造。
 * - 实时：codemode 的 tool_execution_* + 嵌套 MCP 调用（带 parentToolCallId）+ 进度 partialResult.details.calls
 * - 历史：get_messages 还原的 assistant toolCall + toolResult，只有 details.calls，没有嵌套事件
 * 不用随机数；时间相关的只有 reducer 自己记的 startedAt，probe 不断言具体时长。
 */
import type { AgentEvent, AgentMessage } from '../src/lib/pi'

export const SCRIPT = `// @options: {"timeout_ms": 60000}
const [search, wiki] = await Promise.allSettled([
  tools.mcp__anysearch__batch_search({
    queries: [{ query: "antd 6 Splitter collapsible" }, { query: "lobehub ui Highlighter props" }],
  }),
  tools.mcp__deepwiki__ask_wiki_question({
    repoName: "ant-design/ant-design",
    question: "How does Splitter handle collapsible panels?",
  }),
]);
const doc = await tools.mcp__antd__antd_doc({ component: "Splitter" });
text(doc.content[0].text.slice(0, 400));
return { search: search.status, wiki: wiki.status, docChars: doc.content[0].text.length };`

const FULL = 'C:\\Users\\me\\AppData\\Local\\Temp\\mcp-result-'

const SEARCH_ARGS = {
  queries: [{ query: 'antd 6 Splitter collapsible' }, { query: 'lobehub ui Highlighter props' }]
}
const WIKI_ARGS = {
  repoName: 'ant-design/ant-design',
  question: 'How does Splitter handle collapsible panels?'
}
const DOC_ARGS = { component: 'Splitter' }

const SEARCH_TEXT = JSON.stringify({
  results: [
    {
      query: 'antd 6 Splitter collapsible',
      items: [
        { title: 'Splitter - Ant Design', url: 'https://ant.design/components/splitter' },
        { title: 'Splitter collapsible demo', url: 'https://ant.design/components/splitter#collapsible' }
      ]
    },
    {
      query: 'lobehub ui Highlighter props',
      items: [{ title: 'Highlighter - Lobe UI', url: 'https://ui.lobehub.com/components/highlighter' }]
    }
  ]
})

const WIKI_TEXT = `## Collapsible panels

\`Splitter.Panel\` accepts a \`collapsible\` prop. When it is \`true\`, a collapse button is rendered on the bar:

- \`collapsible: { start: true, end: true }\` controls which side shows the arrow.
- \`defaultSize\` / \`size\` keep working after the panel is restored.

\`\`\`tsx
<Splitter>
  <Splitter.Panel collapsible defaultSize="40%">left</Splitter.Panel>
  <Splitter.Panel>right</Splitter.Panel>
</Splitter>
\`\`\``

const DOC_TEXT = `# Splitter

Split panels to isolate content areas.

| Property | Description | Type | Default |
| --- | --- | --- | --- |
| collapsible | Quick folding | boolean \\| { start?: boolean; end?: boolean } | false |
| defaultSize | Initial size | number \\| string | - |
| layout | Layout direction | \`horizontal\` \\| \`vertical\` | \`horizontal\` |`

function mcpResult(text: string, id: string, isError = false): unknown {
  const shaped = `${text}\n全文: ${FULL}${id}`
  return {
    content: [{ type: 'text', text: shaped }],
    isError,
    structuredContent: { content: [{ type: 'text', text }], isError }
  }
}

const OUTPUT_TEXT = DOC_TEXT.slice(0, 400)
const RETURN_TEXT = JSON.stringify({ search: 'fulfilled', wiki: 'fulfilled', docChars: DOC_TEXT.length })

function header(ok: boolean, seconds: string): { type: 'text'; text: string } {
  return { type: 'text', text: `${ok ? 'Script completed' : 'Script failed'}\nWall time ${seconds} seconds\nOutput:\n` }
}

type CallRecord = {
  id: string
  name: string
  args: string
  status: 'running' | 'ok' | 'error' | 'cancelled'
  durationMs?: number
  error?: string
}

function record(id: string, name: string, args: unknown, status: CallRecord['status'], durationMs?: number, error?: string): CallRecord {
  return {
    id,
    name,
    args: JSON.stringify(args),
    status,
    ...(durationMs != null ? { durationMs } : {}),
    ...(error ? { error } : {})
  }
}

function doneCalls(parent: string): CallRecord[] {
  return [
    record(`${parent}/1`, 'mcp__anysearch__batch_search', SEARCH_ARGS, 'ok', 812),
    record(`${parent}/2`, 'mcp__deepwiki__ask_wiki_question', WIKI_ARGS, 'ok', 2380),
    record(`${parent}/3`, 'mcp__antd__antd_doc', DOC_ARGS, 'ok', 95)
  ]
}

function doneResult(parent: string): unknown {
  return {
    content: [header(true, '3.4'), { type: 'text', text: OUTPUT_TEXT }, { type: 'text', text: RETURN_TEXT }],
    details: { calls: doneCalls(parent) }
  }
}

function start(toolCallId: string, toolName: string, args: unknown, parentToolCallId?: string): AgentEvent {
  return { type: 'tool_execution_start', toolCallId, toolName, args, ...(parentToolCallId ? { parentToolCallId } : {}) }
}

function end(toolCallId: string, toolName: string, result: unknown, isError = false, parentToolCallId?: string): AgentEvent {
  return { type: 'tool_execution_end', toolCallId, toolName, result, isError, ...(parentToolCallId ? { parentToolCallId } : {}) }
}

function update(toolCallId: string, calls: CallRecord[]): AgentEvent {
  return { type: 'tool_execution_update', toolCallId, toolName: 'codemode', partialResult: { content: [], details: { calls } } }
}

/** 实时、已完成：3 次嵌套 MCP 调用全部成功。 */
export function liveDoneEvents(): AgentEvent[] {
  const p = 'cm-live'
  return [
    start(p, 'codemode', { code: SCRIPT }),
    start(`${p}/1`, 'mcp__anysearch__batch_search', SEARCH_ARGS, p),
    start(`${p}/2`, 'mcp__deepwiki__ask_wiki_question', WIKI_ARGS, p),
    end(`${p}/1`, 'mcp__anysearch__batch_search', mcpResult(SEARCH_TEXT, '1a2b'), false, p),
    end(`${p}/2`, 'mcp__deepwiki__ask_wiki_question', mcpResult(WIKI_TEXT, '3c4d'), false, p),
    start(`${p}/3`, 'mcp__antd__antd_doc', DOC_ARGS, p),
    end(`${p}/3`, 'mcp__antd__antd_doc', mcpResult(DOC_TEXT, '5e6f'), false, p),
    end(p, 'codemode', doneResult(p))
  ]
}

/** 实时、运行中：第 1 次调用已完成，第 2 次还在跑。 */
export function liveRunningEvents(): AgentEvent[] {
  const p = 'cm-run'
  return [
    start(p, 'codemode', { code: SCRIPT }),
    start(`${p}/1`, 'mcp__anysearch__batch_search', SEARCH_ARGS, p),
    update(p, [{ ...record(`${p}/?`, 'mcp__anysearch__batch_search', SEARCH_ARGS, 'running') }]),
    end(`${p}/1`, 'mcp__anysearch__batch_search', mcpResult(SEARCH_TEXT, '7a8b'), false, p),
    update(p, [record(`${p}/1`, 'mcp__anysearch__batch_search', SEARCH_ARGS, 'ok', 640)]),
    start(`${p}/2`, 'mcp__deepwiki__ask_wiki_question', WIKI_ARGS, p),
    update(p, [
      record(`${p}/1`, 'mcp__anysearch__batch_search', SEARCH_ARGS, 'ok', 640),
      record(`${p}/?`, 'mcp__deepwiki__ask_wiki_question', WIKI_ARGS, 'running')
    ])
  ]
}

/** 实时、失败：deepwiki 调用报错，脚本抛出。 */
export function liveFailedEvents(): AgentEvent[] {
  const p = 'cm-fail'
  const wikiError = 'MCP error -32603: repository ant-design/ant-designx not indexed'
  const calls = [
    record(`${p}/1`, 'mcp__anysearch__batch_search', SEARCH_ARGS, 'ok', 702),
    record(`${p}/2`, 'mcp__deepwiki__ask_wiki_question', { ...WIKI_ARGS, repoName: 'ant-design/ant-designx' }, 'error', 1210, wikiError)
  ]
  return [
    start(p, 'codemode', { code: SCRIPT.replace('ant-design/ant-design"', 'ant-design/ant-designx"') }),
    start(`${p}/1`, 'mcp__anysearch__batch_search', SEARCH_ARGS, p),
    end(`${p}/1`, 'mcp__anysearch__batch_search', mcpResult(SEARCH_TEXT, '9c0d'), false, p),
    start(`${p}/2`, 'mcp__deepwiki__ask_wiki_question', { ...WIKI_ARGS, repoName: 'ant-design/ant-designx' }, p),
    end(`${p}/2`, 'mcp__deepwiki__ask_wiki_question', { content: [{ type: 'text', text: wikiError }] }, true, p),
    end(
      p,
      'codemode',
      {
        content: [
          header(false, '2.0'),
          {
            type: 'text',
            text: `Script error:\nError: ${wikiError}\n    at <anonymous> (script:12)\n\nTool calls made before the failure (they are not undone): mcp__anysearch__batch_search (ok), mcp__deepwiki__ask_wiki_question (error)`
          }
        ],
        details: { calls }
      },
      true
    )
  ]
}

/** 历史、调用很多：9 次 antd_doc，列表只露最后几条。 */
export const MANY_CALLS = 9

export function manyCallsMessages(): AgentMessage[] {
  const p = 'cm-many'
  const components = ['Button', 'Input', 'Select', 'Table', 'Form', 'Modal', 'Drawer', 'Tabs', 'Splitter']
  const calls = components.slice(0, MANY_CALLS).map((component, i) =>
    record(`${p}/${i + 1}`, 'mcp__antd__antd_doc', { component }, 'ok', 40 + i * 7)
  )
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: p,
          name: 'codemode',
          arguments: {
            code: `const names = ${JSON.stringify(components)};\nconst docs = await Promise.all(names.map((component) => tools.mcp__antd__antd_doc({ component })));\nreturn docs.map((d) => d.content[0].text.length);`
          }
        }
      ],
      timestamp: 4
    },
    {
      role: 'toolResult',
      toolCallId: p,
      toolName: 'codemode',
      content: [header(true, '0.6'), { type: 'text', text: JSON.stringify(calls.map((_, i) => 1200 + i)) }],
      details: { calls },
      isError: false,
      timestamp: 5
    }
  ]
}

/** 历史：切回会话时 get_messages 只给出 toolCall + toolResult（含 details.calls），没有嵌套事件。 */
export function historyMessages(): AgentMessage[] {
  const p = 'cm-hist'
  return [
    { role: 'user', content: [{ type: 'text', text: '查一下 antd Splitter 的折叠用法' }], timestamp: 1 },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: p, name: 'codemode', arguments: { code: SCRIPT } }],
      timestamp: 2
    },
    {
      role: 'toolResult',
      toolCallId: p,
      toolName: 'codemode',
      content: (doneResult(p) as { content: unknown }).content,
      details: { calls: doneCalls(p) },
      isError: false,
      timestamp: 3
    }
  ]
}
