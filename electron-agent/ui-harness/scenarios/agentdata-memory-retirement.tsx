import { AgentDataCenter } from '../../src/features/agentData/AgentDataCenter'
import { useSessionStore } from '../../src/store'
import { installBridge, track } from '../stubs'

const WORKSPACE = 'D:/demo/app'

installBridge({
  subscribe: async () => () => {},
  invoke: async (command: string) => {
    track(command)
    switch (command) {
      case 'agentData_status': return { state: 'ready', version: 1 }
      case 'agentData_overview': return {
        libraries: { total: 0, pages: 0, pendingSources: 0 }, recentPages: [],
        activeTasks: 0, failedTasks: 0, diagnostics: { actionRequired: 0, unchecked: 0 }, errors: [],
      }
      case 'agentData_tasks_list': return { items: [], activeCount: 0 }
      case 'agentData_wiki_list': return []
      case 'agentData_code_projects': return [{ workspace: WORKSPACE, indexed: true }]
      case 'agentData_code_status': return { workspace: WORKSPACE, connected: true, indexed: true, state: 'ready', files: 3, nodes: 5, edges: 7 }
      case 'agentData_code_call': return { content: [{ type: 'text', text: '[]' }], structuredContent: { rows: [], nodes: [], edges: [] } }
      case 'agentData_diagnostics_check': return { checkedAt: 1, items: [] }
      case 'agentData_audit_query': return { items: [] }
      default: throw new Error(`unstubbed invoke: ${command}`)
    }
  },
})

useSessionStore.setState({ registeredProjects: [WORKSPACE] })

export default function AgentDataMemoryRetirementScenario() {
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--gren-content-bg)' }}>
    <AgentDataCenter userId="local" initialProject={WORKSPACE} />
  </div>
}
