import { lazy, Suspense, useState, type ReactElement } from 'react'
import type { FilePickerOptions } from '../../electron/ipc/filePicker'
import { App } from 'antd'
import { ExtensionsPanel } from '../../src/features/extensions/ExtensionsPanel'
import { ModuleRail } from '../../src/features/layout/ModuleRail'
import { useModuleStore } from '../../src/stores/moduleStore'
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
  { name: 'beta', config: { url: 'https://mcp.example.test/api', headers: { Authorization: 'Bearer fixture-only', Accept: 'application/json' } }, enabled: true, scope: 'global' },
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
  path: `/agent/skills/${index === 0 ? 'lint-helper' : `skill-${index + 1}`}`,
  scope: index === 1 ? 'project' : 'global',
  ...(index === 2 && {disableModelInvocation:true}),
}))
let source = '---\nname: lint-helper\ndescription: 检查代码\n---\n# 检查步骤\n';
let copied = '';
Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async (value:string) => {copied=value;}}});
const calls: Array<{ command: string; args: Record<string, unknown> }> = []

function publishRuntime(status: McpServerStatus['status']): void {
  useMcpStatusStore.getState().setWorkspaceServers(workspace, [
    { name: 'alpha', transport: 'stdio', status, tools: 1, toolNames: [alphaTool], ...(status === 'failed' && {error:'ECONNREFUSED 127.0.0.1:4010'}), attemptedAt:'2026-11-25T02:00:00Z' },
    { name: 'beta', transport: 'http', status: 'connected', tools: 1, toolNames: ['mcp__beta__search'] },
  ])
}

installBridge({
  window: { isMaximized: async () => false, onResized: async () => () => {} },
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
      case 'inspect_mcp_server': {
        const servers = useMcpStatusStore.getState().serversByWorkspace[workspace] ?? [];
        const item = servers.find(s => s.name === args.name);
        return { servers, catalog: item?.toolNames?.map(fullName => ({fullName, name: fullName.split('__').at(-1), description: fullName.endsWith('antd_list') ? 'List the available components with descriptions, usage examples, and supported properties. '.repeat(3) : fullName.endsWith('tool_80') ? '列出工作区的最后一页' : '按条件读取匹配的条目', inputSchema: {type:'object',properties:{query:{type:'string'}}}})),
          diagnostics: {attemptId:'fixture-attempt', handshake:['等待服务器响应初始化握手'], attemptedAt:item?.attemptedAt ?? '2026-11-25T02:00:00Z', stderr:item?.status === 'failed' ? ['fixture: connection closed'] : []} };
      }
      case 'cancel_mcp_attempt': {
        const items = useMcpStatusStore.getState().serversByWorkspace[workspace] ?? [];
        const ok = args.workspace === workspace && args.name === 'deepwiki' && args.attemptId === 'fixture-attempt' && items.some(s=>s.name === args.name && s.status === 'connecting');
        if (ok) useMcpStatusStore.getState().setWorkspaceServers(workspace, items.map(s=>s.name === args.name ? {...s,status:'stopped'} : s));
        return ok;
      }
      case 'test_mcp_tool': return { content: [{type:'text',text:'fixture result'}] }
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
      case 'extension_directory': return 'C:\\Users\\Example\\.pi\\agent\\prompts'
      case 'open_mcp_directory': case 'open_skill_folder': return
      case 'read_skill': return { content:source, files:['scripts/','SKILL.md'] }
      case 'list_skill_files': return args.folder === 'scripts' ? ['check.js'] : []
      case 'save_skill': source = String(args.content); return
      case 'archive_skill': skills = skills.filter((skill) => skill.path !== args.path); return '/agent/skills-archive/example'
      case 'list_skills': return structuredClone(skills)
      case 'create_skill': {
        const skill: SkillInfo = { name: String(args.name), description: String(args.description), path: `/agent/skills/${args.name}`, scope: 'global' }
        skills = [...skills, skill]
        return skill
      }
      case 'delete_skill': skills = skills.filter((skill) => skill.path !== args.path); return undefined
      case 'import_skill_from_dir':
      case 'import_skill_from_file':
      case 'install_skill_from_zip': {
        const skill: SkillInfo = { name: 'imported-skill', description: '从本机导入', path: '/agent/skills/imported-skill', scope: 'global' }
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
      case 'save_builtin_rule':
        rules = rules.map(rule => rule.path === args.path ? { ...rule, body:String(args.content) } : rule)
        return undefined
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
// Titlebar captures the window bridge on import; load it after installing the stub above.
const Titlebar = lazy(async () => ({ default: (await import('../../src/components/Titlebar')).Titlebar }))
publishRuntime('failed')
const initialEntries = structuredClone(entries)
let remountPanel = () => {}
let showChrome = (_visible: boolean) => {}
let savedSkills: SkillInfo[] | undefined
localStorage.removeItem('pi-skills-catalog-view')
exposeData({ workspace, alphaTool, skillCount: skills.length })
exposeActions({
  showChrome: (visible: boolean) => showChrome(visible),
  snapshot: () => ({ entries, settings, policy: JSON.parse(policy), copied, calls }),
  publishRuntime,
  setLongLibraries: () => {
    const body = Array.from({ length: 100 }, (_, i) => '## 约定 ' + (i + 1) + '\n\n先运行本项目的定向检查，再保存修改。').join('\n\n')
    rules = Array.from({ length: 48 }, (_, i) => {
      const project = '/projects/workspace-' + i, path = project + '/AGENTS.md'
      return { scope:'project', builtinProject:project, id:path, path, title:'AGENTS.md', enabled:true, body }
    })
    commands = Array.from({ length: 48 }, (_, i) => ({ name:'check-' + i, path:'/agent/prompts/check-' + i + '.md',
      body, description:'检查项目配置', params:[] }))
    remountPanel()
  },
  clearCommands: () => { commands = []; remountPanel() },
  /** 临时换成一大批技能（照真实机器上的 40 个），量网格卡片高度；传 false 恢复原列表。 */
  setManySkills: (many: boolean) => {
    if (many) {
      savedSkills = skills
      skills = Array.from({ length: 40 }, (_, index) => ({
        name: `many-${String(index + 1).padStart(2, '0')}`,
        description: index % 3 === 0 ? '短说明。' : index % 3 === 2 ? '读取项目资料并按约定整理需要复核的文件和待办事项。'.repeat(12) : `${'Use when the task needs a long description that wraps across several lines in the grid card. '.repeat(3)}`,
        path: `C:\\Users\\someone\\.agents\\skills\\many-${index + 1}`,
        scope: 'global',
      }))
    } else if (savedSkills) skills = savedSkills
    remountPanel()
  },
  setCrowdedMcp: (crowded: boolean) => {
    entries = crowded ? [
      ...['js-reverse-mcp','antd','deepwiki','network'].map(name=>({name, config:name === 'deepwiki' ? {url:'https://fixture.invalid/mcp'} : {command:'node'}, enabled:true, scope:'global' as const})),
      ...structuredClone(initialEntries),
      ...Array.from({ length: 20 }, (_, index) => ({ name: index === 0 ? 'company-internal-design-system-and-production-observability-mcp-server-with-a-very-long-installation-name' : `extra-${String(index + 1).padStart(2, '0')}`, config: { command: 'node' }, enabled: false, scope: 'settings' as const })),
    ] : structuredClone(initialEntries)
    if (crowded) {
      const runtime: McpServerStatus[] = [];
      for (const [name, count] of [['js-reverse-mcp',81],['antd',8],['network',51],['beta',7]] as const) {
        const names = Array.from({length:count}, (_,i) => `mcp__${name}__${name === 'antd' && !i ? 'antd_list' : 'tool_'+i}`);
        runtime.push({name, status:'connected', tools:count, toolNames:names, attemptedAt:'2026-11-25T02:00:00Z', footprints:names.map(() => [100, name === 'antd' ? 'direct' : 'codemode'])});
      }
      policy = JSON.stringify({...JSON.parse(policy), tools:{...JSON.parse(policy).tools, 'mcp__js-reverse-mcp__tool_0':{permission:'disabled'}}});
      runtime.push({name:'deepwiki', status:'connecting', tools:0, toolNames:[], attemptedAt:new Date(Date.now()-16000).toISOString()});
      useMcpStatusStore.getState().setWorkspaceServers(workspace,runtime)
    } else publishRuntime('failed')
    remountPanel()
  },
})

export default function ExtensionsWorkbenchScenario(): ReactElement {
  const [revision, setRevision] = useState(0)
  const [chrome, setChrome] = useState(false)
  showChrome = (visible) => {
    if (visible) useModuleStore.getState().setActiveModule('extensions')
    setChrome(visible)
  }
  remountPanel = () => setRevision((current) => current + 1)
  return (
    <AgentStoreContext.Provider value={{ workspace, store, workspaceReady: true, setWorkspaceReady: () => {}, appBooted: true }}>
      <App style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        {chrome && <Suspense fallback={null}><Titlebar /></Suspense>}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {chrome && <ModuleRail />}
          <main data-testid="extension-stage" style={{ flex: 1, minWidth: 0, overflow: 'hidden', background: 'var(--gren-content-bg)' }}>
            <ExtensionsPanel key={revision} />
          </main>
        </div>
      </App>
    </AgentStoreContext.Provider>
  )
}
