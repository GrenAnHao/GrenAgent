import { ProjectContextPanel } from '../../src/features/chat/input/workspace/ProjectContextPanel'
import { installBridge, track } from '../stubs'

let attempts = 0
installBridge({
  invoke: async (command: string, args: { workspace: string }) => {
    track(`${command}:${args.workspace}`)
    if (command !== 'agentData_code_status') throw new Error(`Unexpected IPC: ${command}`)
    if (++attempts === 1) throw new Error('索引服务暂不可用')
    return { workspace: args.workspace, indexed: true, connected: true, files: 12, nodes: 48, edges: 75 }
  },
})

export default function ProjectContextScenario() {
  return <div style={{ width: 360, height: '100vh', background: 'var(--gren-content-bg)' }}>
    <ProjectContextPanel active workspace="D:/demo/project" />
  </div>
}
