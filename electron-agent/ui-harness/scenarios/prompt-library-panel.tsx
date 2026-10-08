import { useState, type ReactElement } from 'react'
import { App } from 'antd'
import { CommandsPanel } from '../../src/features/extensions/CommandsPanel'
import { RulesPanel } from '../../src/features/extensions/RulesPanel'
import { exposeActions, installBridge, track } from '../stubs'

/**
 * 命令 / 规则两个页签：真实组件，主进程命令用桩（数据在内存里改）。
 * workspace 可以通过 probe 切成空串，看项目范围置灰。
 */

let commands = [
  { name: 'refactor', description: '按指定风格重构文件', body: '请把 {file} 重构成 {style=functional} 风格。', params: [{ name: 'file' }, { name: 'style', defaultValue: 'functional' }], path: '/a/prompts/refactor.md' }
]
let rules = [
  { id: 'zh', scope: 'global', path: '/a/rules/zh.md', title: '中文回答', enabled: true, body: '- 中文' },
  { id: 'pnpm', scope: 'project', path: '/w/.pi/rules/pnpm.md', title: '用 pnpm', enabled: false, body: '- pnpm' }
]

installBridge({
  invoke: async (command: string, args: Record<string, unknown>) => {
    track(command)
    switch (command) {
      case 'list_prompt_commands': return commands
      case 'agent_get_commands': return [{ name: 'goal', source: 'extension' }, { name: 'refactor', source: 'prompt' }]
      case 'save_prompt_command': {
        const saved = { name: String(args.name), description: String(args.description), body: String(args.body), params: [], path: '' }
        commands = [...commands.filter((c) => c.name !== args.originalName && c.name !== args.name), saved]
        return saved
      }
      case 'list_context_rules': return rules
      case 'set_context_rule_enabled':
        rules = rules.map((r) => (r.scope === args.scope && r.id === args.id ? { ...r, enabled: Boolean(args.enabled) } : r))
        return undefined
      default: throw new Error(`unstubbed invoke: ${command}`)
    }
  }
})

export default function PromptLibraryPanelScenario(): ReactElement {
  const [workspace, setWorkspace] = useState('/w')
  exposeActions({ setWorkspace })
  return (
    <App>
      <div style={{ height: '100vh', boxSizing: 'border-box', padding: 24, overflow: 'auto', background: 'var(--gren-content-bg)' }}>
        <div data-testid="commands-area"><CommandsPanel workspace={workspace} onResourcesChanged={() => track('resources-changed')} /></div>
        <div data-testid="rules-area" style={{ marginTop: 24 }}><RulesPanel key={workspace} workspace={workspace} /></div>
      </div>
    </App>
  )
}
