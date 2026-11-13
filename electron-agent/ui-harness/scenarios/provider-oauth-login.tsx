import type { ReactElement } from 'react'
import { App } from 'antd'
import { ProvidersSettings } from '../../src/features/settings/ProvidersSettings'
import { deferred, exposeActions, exposeData, installBridge, track } from '../stubs'

/**
 * 供应商 OAuth 登录：真实 ProvidersSettings + ProviderOAuthLoginModal。
 * 主进程用桩：能力发现/凭据状态来自固定响应，登录事件由 probe 经 exposeActions 驱动，
 * 时序完全可控，不发真实网络请求、不打开浏览器。
 */

const CAPABILITY = {
  providerId: 'openai',
  name: 'OpenAI (ChatGPT subscription)',
  loginLabel: 'Sign in with ChatGPT',
  isSubscription: true,
}

const OAUTH_CREDENTIAL = {
  providerId: 'openai', type: 'oauth', source: 'OAuth', configured: true,
  expiresAt: 1893456000000, isSubscription: true,
}

type ChannelHandler = (event: { payload: unknown }) => void
const channels = new Map<string, ChannelHandler>()
let credential: typeof OAUTH_CREDENTIAL | null = null
let loginChannel: string | null = null
let loginGate: ReturnType<typeof deferred<unknown>> | null = null
let loginSeq = 0

function emit(event: Record<string, unknown>): void {
  channels.get(`channel:${loginChannel}`)?.({
    payload: { loginId: `login-${loginSeq}`, providerId: 'openai', ...event },
  })
}

installBridge({
  subscribe: async (event: string, handler: ChannelHandler) => {
    channels.set(event, handler)
    return () => channels.delete(event)
  },
  invoke: async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'get_provider_config': return { modelsJson: '{"providers":{}}', authJson: '{}', agentDir: '/agent' }
      case 'get_settings': return {}
      case 'list_models_global': return { ok: true, models: [] }
      case 'get_provider_oauth_capabilities': return [CAPABILITY]
      case 'get_provider_credentials': return credential ? [credential] : []
      case 'set_provider_config': return { refreshed: [], failed: [] }
      case 'set_provider_api_key': track(`setApiKey:${args.provider}`); return undefined
      case 'refresh_model_registry': return { refreshed: [], failed: [] }
      case 'provider_logout':
        track('logout')
        credential = null
        return undefined
      case 'provider_login':
        loginSeq += 1
        track(`login:${args.provider}:${loginSeq}`)
        loginChannel = (args.onEvent as { __grenChannelId: string }).__grenChannelId
        loginGate = deferred<unknown>()
        return loginGate.promise
      case 'provider_login_prompt': track(`prompt:${args.value}`); return undefined
      case 'provider_login_cancel':
        track('cancel')
        loginGate?.resolve(undefined)
        loginGate = null
        return undefined
      default: throw new Error(`unstubbed invoke: ${command}`)
    }
  },
})

exposeActions({
  progress: () => emit({ type: 'progress', message: '正在等待授权…' }),
  authUrl: () => emit({
    type: 'auth_url', url: 'https://auth.example/authorize?state=x', instructions: '在浏览器完成授权',
  }),
  deviceCode: () => emit({
    type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://auth.example/device',
  }),
  prompt: () => emit({
    type: 'prompt', promptId: 'p1',
    prompt: { type: 'manual_code', message: '粘贴回调码', placeholder: 'code' },
  }),
  promptCancelled: () => emit({ type: 'prompt_cancelled', promptId: 'p1' }),
  error: () => emit({ type: 'error', message: 'access_denied' }),
  done: () => {
    credential = OAUTH_CREDENTIAL
    emit({ type: 'done' })
    loginGate?.resolve(undefined)
    loginGate = null
  },
})

exposeData({ capability: CAPABILITY })

export default function ProviderOAuthLoginScenario(): ReactElement {
  return (
    <App>
      <div style={{ height: '100vh', boxSizing: 'border-box', padding: 24, display: 'flex', flexDirection: 'column', background: 'var(--gren-content-bg)' }}>
        <ProvidersSettings />
      </div>
    </App>
  )
}
