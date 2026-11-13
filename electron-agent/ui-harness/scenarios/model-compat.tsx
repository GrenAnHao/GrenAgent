import { useState, type ReactElement } from 'react'
import { App } from 'antd'
import { ProvidersSettings } from '../../src/features/settings/ProvidersSettings'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

let modelsJson = JSON.stringify({ providers: {
  relay: { name: 'OpenAI 兼容', api: 'openai-completions', baseUrl: 'https://fixture.invalid/v1', models: [{ id: 'fixture' }] },
  messages: { name: 'Anthropic 兼容', api: 'anthropic-messages', baseUrl: 'https://fixture.invalid/v1', models: [{ id: 'fixture' }] },
  responses: { name: 'Responses 兼容', api: 'openai-responses', baseUrl: 'https://fixture.invalid/v1', models: [{ id: 'fixture' }] },
} })

installBridge({
  subscribe: async () => () => {},
  invoke: async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'get_provider_config': return { modelsJson, authJson: '{}', agentDir: '/fixture-agent' }
      case 'get_settings': return {}
      case 'set_settings': return undefined
      case 'list_models_global': return { ok: true, models: [] }
      case 'set_provider_config': {
        modelsJson = String(args.modelsJson)
        exposeData({ savedModelsJson: modelsJson })
        track('save')
        return { refreshed: [], failed: [] }
      }
      default: throw new Error(`unstubbed invoke: ${command}`)
    }
  },
})

export default function ModelCompatScenario(): ReactElement {
  const [revision, setRevision] = useState(0)
  exposeActions({ remount: () => setRevision((value) => value + 1) })
  return (
    <App>
      <div data-testid="model-compat-root" data-revision={revision} style={{ height: '100vh', boxSizing: 'border-box', padding: 24, display: 'flex', flexDirection: 'column', background: 'var(--gren-content-bg)' }}>
        <ProvidersSettings key={revision} />
      </div>
    </App>
  )
}
