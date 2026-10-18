import type { ReactElement } from 'react'
import { App } from 'antd'
import { FileTreeBody } from '../../src/features/dock/FileTreeBody'
import { useFileOpenRequests } from '../../src/stores/fileOpenRequests'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

/**
 * 「文件」标签里的文件浏览器：真实 FileTreeBody → FileExplorer（headless-tree + CodeMirror + LazyMarkdown）。
 * 主进程用桩：内存里的一棵文件树；写盘、列目录、监听都记下来给 probe 断言；
 * probe 用 act('externalEdit' / 'addFile') 模拟别的程序改文件，桩按主进程的形状推 files://changed。
 */

// 文件树宽度存在 localStorage 里，上一次跑拖过分隔条会影响宽屏分栏的断言。
localStorage.removeItem('hermes-file-explorer-tree-width')
localStorage.removeItem('hermes-file-explorer-tree-collapsed')

const ROOT = '/repo'
const TAB_ID = `file:right:${ROOT}`
const BIG_DIR_COUNT = 2000

const README = [
  '# Hello Pi',
  '',
  'Some **bold** text and a list:',
  '',
  '- one',
  '- two',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '```ts',
  'const answer = 42',
  '```',
  '',
].join('\n')

const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="12" fill="#5b8def"/></svg>'

type Node = { dir: true } | { dir: false; content: string; binary?: boolean; size?: number }
const fs = new Map<string, Node>()
const dir = (path: string) => fs.set(path, { dir: true })
const file = (path: string, content: string, extra: { binary?: boolean; size?: number } = {}) =>
  fs.set(path, { dir: false, content, ...extra })

dir(ROOT)
dir(`${ROOT}/src`)
dir(`${ROOT}/docs`)
dir(`${ROOT}/big`)
dir(`${ROOT}/node_modules`)
file(`${ROOT}/README.md`, README)
file(`${ROOT}/src/app.ts`, 'export function add(a: number, b: number) {\n  return a + b\n}\n')
file(`${ROOT}/src/util.json`, '{\n  "name": "util",\n  "version": 1\n}\n')
file(`${ROOT}/docs/guide.md`, '# Guide\n\nRead me.\n')
file(`${ROOT}/crlf.txt`, 'line one\r\nline two\r\nline three\r\n')
file(`${ROOT}/logo.svg`, LOGO_SVG)
file(`${ROOT}/app.bin`, '', { binary: true, size: 4096 })
file(`${ROOT}/huge.log`, 'log line\n'.repeat(400), { size: 9 * 1024 * 1024 })
for (let i = 1; i <= BIG_DIR_COUNT; i++) file(`${ROOT}/big/file-${String(i).padStart(4, '0')}.ts`, `export const n = ${i}\n`)

const SKIPPED = new Set(['node_modules', '.git', 'dist', 'out'])
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'))
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function listDir(target: string) {
  const entries = [...fs.entries()]
    .filter(([path]) => parentOf(path) === target && path !== target)
    .filter(([path, node]) => !(node.dir && SKIPPED.has(nameOf(path))))
    .map(([path, node]) => ({
      name: nameOf(path),
      path,
      isDir: node.dir,
      size: node.dir ? null : node.size ?? new TextEncoder().encode(node.content).length,
    }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || collator.compare(a.name, b.name))
  return { dir: target, entries, truncated: false }
}

function resolve(path: string): string {
  const target = path === '' ? ROOT : path
  if (target !== ROOT && !target.startsWith(`${ROOT}/`)) throw new Error('Path escapes workspace')
  if (!fs.has(target)) throw new Error('File does not exist')
  return target
}

type ChangeHandler = (event: { payload: unknown }) => void
let changeHandler: ChangeHandler | null = null
let watched: string[] = []
let writes: Array<{ path: string; content: string }> = []

function emitChange(path: string): void {
  const parent = parentOf(path)
  if (!watched.includes(parent)) return
  changeHandler?.({ payload: { watchId: TAB_ID, workspace: ROOT, dirs: [parent], paths: [path] } })
}

installBridge({
  subscribe: async (event: string, handler: ChangeHandler) => {
    if (event === 'files://changed') changeHandler = handler
    return () => {
      if (changeHandler === handler) changeHandler = null
    }
  },
  invoke: async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'list_dir': {
        const target = resolve(String(args.dir ?? ''))
        track(`list:${target}`)
        return listDir(target)
      }
      case 'read_file_view': {
        const target = resolve(String(args.path))
        const node = fs.get(target)!
        if (node.dir) throw new Error('EISDIR')
        track(`view:${target}`)
        if (node.binary) return { kind: 'binary', size: node.size ?? 0 }
        const size = node.size ?? new TextEncoder().encode(node.content).length
        return { kind: 'text', content: node.content, size, truncated: size > 5 * 1024 * 1024 }
      }
      case 'read_file_binary': {
        const node = fs.get(resolve(String(args.path)))!
        if (node.dir) throw new Error('EISDIR')
        return { mime_type: 'image/svg+xml', data: btoa(node.content), size: node.content.length }
      }
      case 'write_file': {
        const target = String(args.path)
        const content = String(args.content)
        file(target, content)
        writes = [...writes, { path: target, content }]
        track(`write:${target}`)
        exposeData({ writes })
        emitChange(target)
        return undefined
      }
      case 'watch_workspace_dirs': {
        watched = (args.dirs as string[]).map((d) => (d === '' ? ROOT : d))
        exposeData({ watched })
        return undefined
      }
      case 'unwatch_workspace_dirs':
        watched = []
        return undefined
      case 'open_workspace_file':
        track(`open:${String(args.path)}`)
        return undefined
      default:
        throw new Error(`unstubbed invoke: ${command}`)
    }
  },
})

exposeActions({
  /** 别的程序改了文件（例如 agent 的 write 工具）。 */
  externalEdit: (path: string, content: string) => {
    file(path, content)
    emitChange(path)
  },
  addFile: (path: string, content: string) => {
    file(path, content)
    emitChange(path)
  },
  /** 交付卡 / 审查标签的「打开」：向「文件」标签发一条打开请求（真实 store）。 */
  requestOpen: (path: string) => {
    useFileOpenRequests.getState().request(TAB_ID, path)
  },
})
exposeData({ root: ROOT, tabId: TAB_ID, bigCount: BIG_DIR_COUNT, writes: [], watched: [] })

const TAB = {
  id: TAB_ID,
  kind: 'file' as const,
  region: 'right' as const,
  title: '文件',
  closable: true,
  order: 0,
  payload: { workspace: ROOT },
}

export default function FileExplorerScenario(): ReactElement {
  return (
    <App>
      <div style={{ height: '100vh', background: 'var(--gren-content-bg)' }}>
        <FileTreeBody tab={TAB} active />
      </div>
    </App>
  )
}
