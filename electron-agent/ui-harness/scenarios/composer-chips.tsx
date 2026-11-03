import { useMemo, type ReactElement } from 'react'
import { useEditor } from '@lobehub/editor/react'
import { ChatInputProvider, type ChatInputContextValue } from '../../src/features/chat/input/ChatInputContext'
import { InputChips } from '../../src/features/chat/input/editor/InputChips'
import { EMPTY_COMPOSER_FILES, useComposerFilesStore } from '../../src/features/chat/input/composerFiles'
import { makePastedText } from '../../src/features/chat/input/editor/pastedText'
import { binaryToImageAttachment } from '../../src/features/chat/input/editor/imageAttachment'
import { exposeActions, exposeData, installBridge } from '../stubs'

/**
 * 输入框上方的图片 / 粘贴块：真实 InputChips + 真实 composerFiles store（挂着 IndexedDB persist）。
 * 图片点开要能放大（lobehub Image 预览）；store 清空内存后 rehydrate 能从 IndexedDB 读回来，url 由 data 重建。
 * 落盘的原始内容经 readStored 读出来给 probe 看：里面不该有 url。
 */

installBridge({})

const KEY = 'D:/ws/a.jsonl'

/** 用 canvas 画一张纯色 PNG：尺寸足够大，预览里才看得出放大。base64 在运行时算出来经 exposeData 交给 probe。 */
function solidPng(width: number, height: number, color: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
  return canvas.toDataURL('image/png').split(',')[1]
}
const RED_PNG = solidPng(640, 400, '#d33')
const BLUE_PNG = solidPng(400, 640, '#36c')

exposeData({ key: KEY, red: RED_PNG, blue: BLUE_PNG })

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pi-composer-files', 1)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

exposeActions({
  reset: async () => {
    useComposerFilesStore.setState({ byKey: {} })
    await useComposerFilesStore.persist.clearStorage()
  },
  addImages: () => {
    useComposerFilesStore.getState().addAttachments(KEY, [
      binaryToImageAttachment('red.png', 'image/png', RED_PNG),
      binaryToImageAttachment('blue.png', 'image/png', BLUE_PNG),
    ])
  },
  addChip: () => {
    useComposerFilesStore.getState().addPastedText(KEY, { ...makePastedText('line1\nline2\nline3'), id: 'pt-fixed' })
  },
  dropMemory: () => useComposerFilesStore.setState({ byKey: {} }),
  /** 模拟重启只清内存；临时关闭写入，避免生成独立 owner 桶的删除遮罩。 */
  dropMemoryKeepStorage: () => {
    const storage = useComposerFilesStore.persist.getOptions().storage
    if (!storage) throw new Error('composerFiles persist storage missing')
    useComposerFilesStore.persist.setOptions({ storage: { ...storage, setItem: () => {} } })
    try {
      useComposerFilesStore.setState({ byKey: {} })
    } finally {
      useComposerFilesStore.persist.setOptions({ storage })
    }
  },
  rehydrate: async () => {
    await useComposerFilesStore.persist.rehydrate()
  },
  snapshot: () => {
    const files = useComposerFilesStore.getState().byKey[KEY] ?? EMPTY_COMPOSER_FILES
    return {
      images: files.attachments.map((a) => ({ name: a.name, data: a.data, url: a.url })),
      chips: files.pastedTexts.map((p) => ({ id: p.id, lines: p.lines, text: p.text })),
    }
  },
  readStored,
})

async function readStored(): Promise<string | null> {
  const db = await openIdb()
  const value = await new Promise<unknown>((resolve, reject) => {
    const req = db.transaction('kv', 'readonly').objectStore('kv').get('pi-composer-files')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  db.close()
  return typeof value === 'string' ? value : null
}

export default function ComposerChipsScenario(): ReactElement {
  const editor = useEditor()
  const files = useComposerFilesStore((s) => s.byKey[KEY]) ?? EMPTY_COMPOSER_FILES
  const ctx = useMemo<ChatInputContextValue>(
    () => ({
      editor,
      empty: true,
      setEmpty: () => undefined,
      setValue: () => undefined,
      readDraft: () => '',
      attachments: files.attachments,
      addAttachments: (items) => useComposerFilesStore.getState().addAttachments(KEY, items),
      removeAttachment: (index) => useComposerFilesStore.getState().removeAttachment(KEY, index),
      pastedTexts: files.pastedTexts,
      addPastedText: (text) => useComposerFilesStore.getState().addPastedText(KEY, text),
      removePastedText: (id) => useComposerFilesStore.getState().removePastedText(KEY, id),
      isStreaming: false,
      isGenerating: false,
      hasRunningTool: false,
      steering: [],
      followUp: [],
      steerQueued: () => undefined,
      interruptQueued: () => undefined,
      hasComposerQueue: false,
      inFlight: false,
      retrying: false,
      send: () => undefined,
      stop: () => undefined,
    }),
    [editor, files],
  )
  return (
    <div style={{ height: '100vh', boxSizing: 'border-box', padding: 24, background: 'var(--gren-content-bg)' }}>
      <ChatInputProvider value={ctx}>
        <div data-testid="chips" style={{ padding: 12, borderRadius: 12, border: '1px solid var(--ant-color-border-secondary)', minHeight: 60 }}>
          <InputChips />
        </div>
      </ChatInputProvider>
    </div>
  )
}
