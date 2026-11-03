import { useState, type ReactElement } from 'react'
import type { FilePickerOptions } from '../../electron/ipc/filePicker'
import { App } from 'antd'
import { ExtensionsPanel } from '../../src/features/extensions/ExtensionsPanel'
import type { McpConfig } from '../../src/features/extensions/mcpConfig'
import type { ManagedMcpConfig } from '../../src/lib/pi'
import type { PromptCommandInfo, RuleInfo } from '../../src/lib/promptLibraryIo'
import type { SkillInfo } from '../../src/lib/skillsIo'
import { createAgentStore } from '../../src/stores/agent'
import { AgentStoreContext } from '../../src/stores/AgentStoreContext'
import { useMcpStatusStore, type McpServerStatus } from '../../src/stores/mcpStatusStore'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

// 真实四页与主题；只有主进程的文件、配置和连接 I/O 换成确定性的内存盘。
const workspace = '/work/extensions'
const alphaTool = 'mcp__alpha__read_file'
let entries: ManagedMcpConfig[] = [
  { name: 'alpha', config: { command: 'node', args: ['alpha.mjs'] }, enabled: true, scope: 'project' },
  { name: 'beta', config: { url: 'https://mcp.example.test/api' }, enabled: true, scope: 'global' },
  { name: 'cached-only', config: { command: 'node', args: ['cached.mjs'] }, enabled: true, scope: 'settings' },
  { name: 'paused', config: { command: 'node', args: ['paused.mjs'] }, enabled: false, scope: 'settings' },
]
let settings: Record<string, string> = { SKILLS_DISABLED: 'skill:lint-helper' }
let policy = JSON.stringify({ tools: { [alphaTool]: { permission: 'disabled' }, mcp__beta__search: { permission: 'needs_approval' } } })
let commands: PromptCommandInfo[] = [
  { name: 'refactor', description: '按风格重构指定文件', body: '重构 {file}，使用 {style=functional} 风格。', params: [{ name: 'file' }, { name: 'style', defaultValue: 'functional' }], path: '/agent/prompts/refactor.md' },
  { name: 'review', description: '检查本次修改', body: '审查 {target}。', params: [{ name: 'target' }], path: '/agent/prompts/review.md' },
]
let rules: RuleInfo[] = [
  { id: 'zh', scope: 'global', path: '/agent/rules/zh.md', title: '中文回答', enabled: true, body: '使用中文回答。' },
  { id: 'pnpm', scope: 'project', path: `${workspace}/.pi/rules/pnpm.md`, title: '使用 pnpm', enabled: false, body: '使用 pnpm 管理依赖。', modes: ['agent', 'plan'] },
]
let skills: SkillInfo[] = Array.from({ length: 8 }, (_, index) => ({
  name: index === 0 ? 'lint-helper' : `skill-${index + 1}`,
  description: index === 0 ? '检查代码规范并列出可以直接修复的问题。' : `第 ${index + 1} 个本机技能，包含较长说明以检查网格和窄列换行。`,
  path: `/agent/skills/${index === 0 ? 'lint-helper' : `skill-${index + 1}`}/SKILL.md`,
  scope: 'global',
}))
const calls: Array<{ command: string; args: Record<string, unknown> }> = []

function publishRuntime(status: McpServerStatus['status']): void {
  useMcpStatusStore.getState().setWorkspaceServers(workspace, [
    { name: 'alpha', transport: 'stdio', status, tools: 1, toolNames: [alphaTool] },
    { name: 'beta', transport: 'http', status: 'connected', tools: 1, toolNames: ['mcp__beta__search'] },
  ])
}

installBridge({
  subscribe: async () => () => {},
  pickDirectory: async () => { track('pick-directory'); return '/fixtures/imported-skill' },
  pickFile: async (options?: FilePickerOptions) => {
    const extensions = options?.filters?.flatMap((filter) => filter.extensions) ?? []
    track(`pick-file:${extensions.join(',')}`)
    return extensions.includes('zip') ? '/fixtures/skill.zip' : '/fixtures/SKILL.md'
  },
  openUrl: async (url: string) => track(`open-url:${url}`),
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    track(command)
    calls.push({ command, args: structuredClone(args) })
    switch (command) {
      case 'get_settings': return { ...settings }
      case 'set_settings': settings = { ...(args.settings as Record<string, string>) }; return undefined
      case 'list_mcp_configs': return structuredClone(entries)
      case 'upsert_mcp_config': {
        entries = [...entries.filter((entry) => entry.name !== args.name), {
          name: String(args.name), config: args.config as McpConfig, scope: args.scope as ManagedMcpConfig['scope'], enabled: Boolean(args.enabled),
        }]
        return undefined
      }
      case 'remove_mcp_config': entries = entries.filter((entry) => entry.name !== args.name); return undefined
      case 'reload_mcp_server': publishRuntime('connected'); return undefined
      case 'read_mcp_policy': return policy
      case 'write_mcp_policy': policy = String(args.content); return undefined
      case 'read_mcp_tools_cache': return JSON.stringify({
        alpha: { toolNames: [alphaTool], probedAt: '2026-10-31T00:00:00Z', ok: true },
        beta: { toolNames: ['mcp__beta__search'], probedAt: '2026-10-31T00:00:00Z', ok: true },
        'cached-only': { toolNames: ['mcp__cached-only__list'], probedAt: '2026-10-31T00:00:00Z', ok: true },
      })
      case 'probe_mcp_server': return '{}'
      case 'read_mcp_audit': return ''
      case 'list_skills': return structuredClone(skills)
      case 'create_skill': {
        const skill: SkillInfo = { name: String(args.name), description: String(args.description), path: `/agent/skills/${args.name}/SKILL.md`, scope: 'global' }
        skills = [...skills, skill]
        return skill
      }
      case 'delete_skill': skills = skills.filter((skill) => skill.path !== args.path); return undefined
      case 'import_skill_from_dir':
      case 'import_skill_from_file':
      case 'install_skill_from_zip': {
        const skill: SkillInfo = { name: 'imported-skill', description: '从本机导入', path: '/agent/skills/imported-skill/SKILL.md', scope: 'global' }
        skills = [...skills.filter((item) => item.name !== skill.name), skill]
        return skill
      }
      case 'open_skills_dir': return '/agent/skills'
      case 'list_prompt_commands': return structuredClone(commands)
      case 'agent_get_commands': return [{ name: 'goal', source: 'extension' }, ...commands.map(({ name }) => ({ name, source: 'prompt' }))]
      case 'save_prompt_command': {
        const saved: PromptCommandInfo = { name: String(args.name), description: String(args.description), body: String(args.body), params: [], path: `/agent/prompts/${args.name}.md` }
        commands = [...commands.filter((item) => item.name !== args.originalName && item.name !== args.name), saved]
        return saved
      }
      case 'delete_prompt_command': commands = commands.filter((item) => item.name !== args.name); return undefined
      case 'list_context_rules': return structuredClone(rules)
      case 'set_context_rule_enabled': rules = rules.map((rule) => rule.scope === args.scope && rule.id === args.id ? { ...rule, enabled: Boolean(args.enabled) } : rule); return undefined
      case 'save_context_rule': {
        const original = args.original as { scope: RuleInfo['scope']; id: string } | undefined
        const saved: RuleInfo = { id: original?.id ?? String(args.title), scope: args.scope as RuleInfo['scope'], title: String(args.title), body: String(args.body), enabled: Boolean(args.enabled), path: '/agent/rules/saved.md', modes: args.modes as RuleInfo['modes'] }
        rules = [...rules.filter((item) => !(item.id === original?.id && item.scope === original?.scope)), saved]
        return saved
      }
      case 'delete_context_rule': rules = rules.filter((item) => !(item.id === args.id && item.scope === args.scope)); return undefined
      default: throw new Error(`unstubbed invoke: ${command}`)
    }
  },
})

const store = createAgentStore(workspace)
publishRuntime('failed')
const initialEntries = structuredClone(entries)
let remountPanel = () => {}
let savedSkills: SkillInfo[] | undefined
localStorage.removeItem('pi-skills-catalog-view')
exposeData({ workspace, alphaTool, skillCount: skills.length })
exposeActions({
  snapshot: () => ({ entries, settings, policy: JSON.parse(policy), calls }),
  publishRuntime,
  /** 临时换成一大批技能（照真实机器上的 40 个），量网格卡片高度；传 false 恢复原列表。 */
  setManySkills: (many: boolean) => {
    if (many) {
      savedSkills = skills
      skills = Array.from({ length: 40 }, (_, index) => ({
        name: `many-${String(index + 1).padStart(2, '0')}`,
        description: index % 3 === 0 ? '短说明。' : `${'Use when the task needs a long description that wraps across several lines in the grid card. '.repeat(3)}`,
        path: `C:\\Users\\someone\\.agents\\skills\\many-${index + 1}`,
        scope: 'global',
      }))
    } else if (savedSkills) skills = savedSkills
    remountPanel()
  },
  setCrowdedMcp: (crowded: boolean) => {
    entries = crowded ? [
      ...structuredClone(initialEntries),
      ...Array.from({ length: 20 }, (_, index) => ({ name: `extra-${String(index + 1).padStart(2, '0')}`, config: { command: 'node' }, enabled: false, scope: 'settings' as const })),
    ] : structuredClone(initialEntries)
    if (crowded) {
      const toolNames = [alphaTool, ...Array.from({ length: 39 }, (_, index) => `mcp__alpha__tool_${index + 1}`)]
      useMcpStatusStore.getState().setWorkspaceServers(workspace, [{ name: 'alpha', transport: 'stdio', status: 'connected', tools: toolNames.length, toolNames }])
    } else publishRuntime('failed')
    remountPanel()
  },
})

export default function ExtensionsWorkbenchScenario(): ReactElement {
  const [revision, setRevision] = useState(0)
  remountPanel = () => setRevision((current) => current + 1)
  return (
    <AgentStoreContext.Provider value={{ workspace, store, workspaceReady: true, setWorkspaceReady: () => {}, appBooted: true }}>
      <App>
        <main data-testid="extension-stage" style={{ height: '100vh', overflow: 'hidden', background: 'var(--gren-content-bg)' }}>
          <ExtensionsPanel key={revision} />
        </main>
      </App>
    </AgentStoreContext.Provider>
  )
}
