import { useEffect, useState } from 'react'
import { App } from 'antd'
import { AppLinkGuard } from '../../src/features/links/AppLinkGuard'
import { LazyMarkdown } from '../../src/features/chat/LazyMarkdown'
import { FileTreeBody } from '../../src/features/dock/FileTreeBody'
import { useDockStore, type FilePayload } from '../../src/stores/dockStore'
import { useFileOpenRequests } from '../../src/stores/fileOpenRequests'
import { useSessionStore } from '../../src/store/session'
import { useLayoutStore } from '../../src/stores/layoutStore'
import { exposeData, installBridge, track } from '../stubs'

// 会话正文的原始 href → AppLinkGuard → opener → 真实 FileTreeBody。
// 桥只接受真实 Windows 根，不替错误的 /D:/ 路径纠错。
const ROOT = 'D:/Link Workspace/Pi'
const FIRST = `${ROOT}/docs/README.md`
const SECOND = `${ROOT}/docs/other.md`
const IMAGE = `${ROOT}/shots/result.png`
const nodes = new Map<string, string | null>([
  [ROOT, null], [`${ROOT}/docs`, null], [`${ROOT}/shots`, null],
  [FIRST, '# 链接打开成功\n\n[预览里的绝对链接](</D:/Link Workspace/Pi/docs/other.md>)\n'],
  [SECOND, '# 第二个文件\n'], [IMAGE, 'image'],
])
const canvas = document.createElement('canvas')
canvas.width = 80
canvas.height = 50
const drawing = canvas.getContext('2d')!
drawing.fillStyle = '#1677ff'
drawing.fillRect(0, 0, 80, 50)
const image = canvas.toDataURL('image/png').split(',')[1]
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'))
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
installBridge({
  subscribe: async () => () => {},
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === 'unwatch_workspace_dirs') return
    const workspace = String(args.workspace ?? '')
    track(`${command}:${workspace}:${String(args.path ?? args.dir ?? '')}`)
    if (workspace !== ROOT) throw new Error('workspace path does not exist')
    if (command === 'watch_workspace_dirs') return
    if (command === 'list_dir') {
      const target = String(args.dir ?? '') || ROOT
      if (nodes.get(target) !== null) throw new Error('Directory does not exist')
      return { dir: target, truncated: false, entries: [...nodes.entries()]
        .filter(([path]) => path !== ROOT && parentOf(path) === target)
        .map(([path, content]) => ({ name: nameOf(path), path, isDir: content === null, size: content === null ? null : content.length })) }
    }
    const path = String(args.path)
    const content = nodes.get(path)
    if (content == null) throw new Error('File does not exist')
    if (command === 'read_file_view') return { kind: 'text', content, size: content.length, truncated: false }
    if (command === 'read_file_binary') return { mime_type: 'image/png', data: image, size: image.length }
    throw new Error(`unexpected command: ${command}`)
  },
})
useSessionStore.setState({ activeWorkspace: ROOT, activeSessionPath: `${ROOT}/session.jsonl`, worksDir: '/works', draftConversationCwd: null })
useDockStore.setState({ tabs: [], closedTabs: [], activeByRegion: { right: null, bottom: null }, activeBySession: {}, rightOpenBySession: {}, rightFillBySession: {} })
useFileOpenRequests.setState({ byTab: {} })
useLayoutStore.setState({ rightPanelOpen: false })
exposeData({ root: ROOT, first: FIRST, second: SECOND, image: IMAGE })

const markdown = [
  '[查看验证记录](</D:/Link Workspace/Pi/docs/README.md>)',
  '[查看编码盘符](</D%3A/Link%20Workspace/Pi/docs/other.md>)',
  '[查看截图](</D:/Link Workspace/Pi/shots/result.png>)',
  '[普通相对链接](docs/README.md)',
  '[缺失文件](</D:/Link Workspace/Pi/docs/missing.md>)',
].join('\n\n')

export default function ChatFileLinks() {
  const tabs = useDockStore((state) => state.tabs)
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    exposeData({ roots: tabs.filter((tab) => tab.kind === 'file').map((tab) => (tab.payload as FilePayload).workspace) })
  }, [tabs])
  return <App>
    <AppLinkGuard />
    <div style={{ display: 'grid', gridTemplateColumns: '320px minmax(0, 1fr)', height: '100vh', background: 'var(--gren-content-bg)' }}>
      <div id="conversation-links" style={{ padding: 20 }}>
        <LazyMarkdown variant="chat">{markdown}</LazyMarkdown>
        <button id="remount-manager" onClick={() => setGeneration((value) => value + 1)}>重新打开文件管理器</button>
      </div>
      <div id="linked-file-manager" style={{ minWidth: 0, minHeight: 0 }}>
        {tabs.filter((tab) => tab.kind === 'file').map((tab) => <FileTreeBody key={`${tab.id}:${generation}`} tab={tab} active />)}
      </div>
    </div>
  </App>
}
