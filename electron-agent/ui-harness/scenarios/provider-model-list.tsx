import type { ReactElement } from 'react'
import { App } from 'antd'
import { ProvidersSettings } from '../../src/features/settings/ProvidersSettings'
import { exposeData, installBridge, track } from '../stubs'

/**
 * 供应商的模型列表：真实 ProvidersSettings + SortableModelCards + ProviderModelCard。
 * 主进程用桩：models.json 里一个自定义供应商 relay，三个模型；保存时把写盘的 models.json 暴露给 probe。
 */

const MODELS_JSON = JSON.stringify({
  providers: {
    relay: {
      name: 'Relay 中转',
      api: 'anthropic-messages',
      baseUrl: 'https://relay.example/v1',
      apiKey: 'sk-relay',
      models: [
        { id: 'alpha', cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
        { id: 'beta' },
        { id: 'gamma' },
      ],
    },
  },
})

installBridge({
  subscribe: async () => () => {},
  invoke: async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'get_provider_config': return { modelsJson: MODELS_JSON, authJson: '{}', agentDir: '/agent' }
      case 'get_settings': return {}
      case 'set_settings': return undefined
      case 'list_models_global': return { ok: true, models: [] }
      case 'set_provider_config': {
        track('save')
        exposeData({ savedModelsJson: String(args.modelsJson) })
        return { refreshed: [], failed: [] }
      }
      default: throw new Error(`unstubbed invoke: ${command}`)
    }
  },
})

export default function ProviderModelListScenario(): ReactElement {
  return (
    <App>
      <div style={{ height: '100vh', boxSizing: 'border-box', padding: 24, display: 'flex', flexDirection: 'column', background: 'var(--gren-content-bg)' }}>
        <ProvidersSettings />
      </div>
    </App>
  )
}
