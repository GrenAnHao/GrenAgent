import { useState, type ReactElement } from 'react'
import { App } from 'antd'
import { CommandsPanel } from '../../src/features/extensions/CommandsPanel'
import { RulesPanel } from '../../src/features/extensions/RulesPanel'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

/**
 * 命令 / 规则两个页签：真实组件，主进程命令用桩（数据在内存里改）。
 * workspace 可以通过 probe 切成空串，看项目范围置灰。
 * 规则带适用模式（modes）：保存走 save_context_rule 桩，内存里改完再 list 读回。
 */

let commands = [
  { name: 'refactor', description: '按指定风格重构文件', body: '请把 {file} 重构成 {style=functional} 风格。', params: [{ name: 'file' }, { name: 'style', defaultValue: 'functional' }], path: '/a/prompts/refactor.md' }
]
let rules = [
  { id: 'zh', scope: 'global', path: '/a/rules/zh.md', title: '中文回答', enabled: true, body: '- 中文' },
  { id: 'ultra', scope: 'global', path: '/a/rules/ultra.md', title: 'Ultra 调度', enabled: true, body: '- 派工', modes: ['ultra'] },
  { id: 'pnpm', scope: 'project', path: '/w/.pi/rules/pnpm.md', title: '用 pnpm', enabled: false, body: '- pnpm' }
]

/** probe 断言用：最近一次写到「盘上」的规则 */
let lastSavedRule: Record<string, unknown> | null = null

exposeData({ ruleModesInitial: ['ultra'] })

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
      case 'save_context_rule': {
        const original = args.original as { scope?: string; id?: string } | undefined
        const modes = Array.isArray(args.modes) ? (args.modes as string[]) : undefined
        const saved: Record<string, unknown> = {
          scope: String(args.scope),
          id: original?.id ?? String(args.title),
          path: '/a/rules/saved.md',
          title: String(args.title),
          enabled: Boolean(args.enabled),
          body: String(args.body),
          ...(modes && modes.length > 0 ? { modes } : {}),
        }
        lastSavedRule = saved
        rules = [
          ...rules.filter((r) => !(r.scope === original?.scope && r.id === original?.id)),
          saved as (typeof rules)[number],
        ]
        return saved
      }
      default: throw new Error(`unstubbed invoke: ${command}`)
    }
  }
})

export default function PromptLibraryPanelScenario(): ReactElement {
  const [workspace, setWorkspace] = useState('/w')
  exposeActions({ setWorkspace, lastSavedRule: () => lastSavedRule })
  return (
    <App>
      <div style={{ height: '100vh', boxSizing: 'border-box', padding: 24, overflow: 'auto', background: 'var(--gren-content-bg)' }}>
        <div data-testid="commands-area" style={{ containerType: 'inline-size', containerName: 'extension-content' }}><CommandsPanel workspace={workspace} onResourcesChanged={() => track('resources-changed')} /></div>
        <div data-testid="rules-area" style={{ marginTop: 24, containerType: 'inline-size', containerName: 'extension-content' }}><RulesPanel key={workspace} workspace={workspace} /></div>
      </div>
    </App>
  )
}
