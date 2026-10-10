import type { ReactElement } from 'react'
import { App } from 'antd'
import { ProvidersSettings } from '../../src/features/settings/ProvidersSettings'
import { deferred, exposeActions, exposeData, installBridge, track } from '../stubs'

/**
 * 供应商设置的两层布局：上层设置、下层模型测活。真实 ProvidersSettings + ProviderDiagnostics，
 * 主进程用桩：models.json 里一个自定义供应商 relay；测活请求由 probe 通过 act 推分片、放行或取消。
 */

const MODELS_JSON = JSON.stringify({
  providers: {
    relay: {
      name: 'Relay 中转',
      api: 'anthropic-messages',
      baseUrl: 'https://relay.example/v1',
      apiKey: 'sk-relay',
      models: [
        { id: 'claude-relay', reasoning: true, thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: 'max', max: null } },
        { id: 'plain-relay', reasoning: false },
        ...Array.from({ length: 8 }, (_, i) => ({ id: `filler-${i + 1}`, reasoning: false })),
      ],
    },
  },
})

const CATALOG = [
  { provider: 'relay', id: 'claude-relay', api: 'anthropic-messages', reasoning: true, thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: 'max', max: null } },
  { provider: 'relay', id: 'plain-relay', api: 'anthropic-messages', reasoning: false },
  { provider: 'openai', id: 'gpt-5', api: 'openai-responses', reasoning: true },
]

const OK_RESULT = {
  ok: true, cancelled: false, error: null, content: 'I am Claude.', thinking: 'The user asks who I am.',
  ttftMs: 420, totalMs: 1830, promptTokens: 11, completionTokens: 48, reasoningTokens: 30, totalTokens: 59, tokensPerSec: 26.2,
}

type ChannelHandler = (event: { payload: unknown }) => void
const channels = new Map<string, ChannelHandler>()
let pending: { requestId: string; channel: string; gate: ReturnType<typeof deferred<unknown>>; content: string; thinking: string } | null = null

function push(type: 'text' | 'thinking', text: string): void {
  if (!pending) throw new Error('没有在飞的测活请求')
  if (type === 'text') pending.content += text
  else pending.thinking += text
  channels.get(pending.channel)?.({ payload: { type, text } })
}

installBridge({
  subscribe: async (event: string, handler: ChannelHandler) => {
    channels.set(event, handler)
    return () => channels.delete(event)
  },
  invoke: async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'get_provider_config': return { modelsJson: MODELS_JSON, authJson: '{}', agentDir: '/agent' }
      case 'get_settings': return {}
      case 'list_models_global': return { ok: true, models: CATALOG }
      case 'diagnose_provider_model': {
        const requestId = String(args.requestId)
        track(`diagnose:${args.providerId}/${args.modelId}:${args.reasoning ?? 'off'}:${args.stream ? 'stream' : 'batch'}`)
        const gate = deferred<unknown>()
        pending = { requestId, channel: `channel:${(args.onChunk as { __grenChannelId: string }).__grenChannelId}`, gate, content: '', thinking: '' }
        return gate.promise
      }
      case 'diagnose_provider_model_abort': {
        track(`abort:${args.requestId === pending?.requestId ? 'current' : 'stale'}`)
        if (pending && args.requestId === pending.requestId) {
          const { content, thinking } = pending
          pending.gate.resolve({ ...OK_RESULT, ok: false, cancelled: true, content, thinking, tokensPerSec: null })
          pending = null
        }
        return undefined
      }
      default: throw new Error(`unstubbed invoke: ${command}`)
    }
  },
})

exposeActions({
  pushThinking: (text: string) => push('thinking', text),
  pushText: (text: string) => push('text', text),
  finish: () => {
    if (!pending) throw new Error('没有在飞的测活请求')
    pending.gate.resolve(OK_RESULT)
    pending = null
  },
})
exposeData({ okResult: OK_RESULT })

export default function ProviderDiagnosticsScenario(): ReactElement {
  return (
    <App>
      <div style={{ height: '100vh', boxSizing: 'border-box', padding: 24, display: 'flex', flexDirection: 'column', background: 'var(--gren-content-bg)' }}>
        <ProvidersSettings />
      </div>
    </App>
  )
}
