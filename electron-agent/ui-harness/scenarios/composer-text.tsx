import { useEffect, useMemo, type ReactElement } from 'react'
import { Editor, useEditor } from '@lobehub/editor/react'
import { CONTROLLED_TEXT_INSERTION_COMMAND } from 'lexical'
import ReactChatTagPlugin from '../../src/features/chat/input/editor/ChatTag/ReactChatTagPlugin'
import ReactCommandPillPlugin from '../../src/features/chat/input/editor/CommandPill/ReactCommandPillPlugin'
import { CommandPillHostContext } from '../../src/features/chat/input/editor/CommandPill/hostContext'
import { INSERT_CHAT_TAG_COMMAND } from '../../src/features/chat/input/editor/ChatTag/command'
import { INSERT_COMMAND_PILL_COMMAND } from '../../src/features/chat/input/editor/CommandPill/commands'
import { readComposerText, writeComposerText } from '../../src/features/chat/input/editor/CommandPill/composerText'
import { readComposerDraft, writeComposerDraft, type ComposerDraft } from '../../src/features/chat/input/editor/composerDraft'
import { exposeActions, track } from '../stubs'

/**
 * 输入框正文原样发出：真实 lobehub Editor，编辑器参数照 MessageEditor（type text、chat、纯文本粘贴、关 markdown）。
 * 回车发送走 readComposerText（发送和存草稿同一个函数），回填走 writeComposerText（草稿恢复、发送失败、编辑消息、撤回引导）。
 * readMarkdown 只给 probe 记录旧路径 getDocument('markdown') 的输出做对照，不参与断言。
 * 整份草稿（切会话 / 重启恢复）走 readComposerDraft / writeComposerDraft：saveDraft 把当前内容按 JSON 存进场景内存，
 * restoreDraft 经 JSON 序列化一次（和 localStorage 同一条路）再写回。
 */

const REFACTOR_PARAMS = [{ name: 'file' }, { name: 'style', defaultValue: 'functional' }]

export default function ComposerTextScenario(): ReactElement {
  const editor = useEditor()
  const host = useMemo(() => ({ submit: () => track(`send:${readComposerText(editor)}`) }), [editor])

  useEffect(() => {
    let saved: ComposerDraft | null = null
    exposeActions({
      insertPill: () => {
        editor.focus()
        editor.dispatchCommand(INSERT_COMMAND_PILL_COMMAND, { name: 'refactor', params: REFACTOR_PARAMS })
      },
      saveDraft: () => {
        saved = JSON.parse(JSON.stringify(readComposerDraft(editor))) as ComposerDraft
        return { text: saved.text, hasJson: saved.json !== undefined }
      },
      restoreDraft: () => {
        writeComposerDraft(editor, saved)
        editor.focus()
      },
      restoreTextOnly: () => {
        writeComposerDraft(editor, saved ? { text: saved.text } : null)
        editor.focus()
      },
      clear: () => editor.cleanDocument(),
      focus: () => editor.focus(),
      read: () => readComposerText(editor),
      readMarkdown: () => String(editor.getDocument('markdown') ?? ''),
      restore: (text: string) => {
        writeComposerText(editor, text)
        editor.focus()
      },
      // 系统剪贴板不可用时 probe 用这个顺着粘贴的后半段走：lobehub handlePlainTextPaste 拿到文本后就是派发这条命令
      insertAsPaste: (text: string) => {
        editor.focus()
        editor.getLexicalEditor()?.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, text)
      },
      insertFileTag: () => {
        editor.focus()
        editor.dispatchCommand(INSERT_CHAT_TAG_COMMAND, { category: 'file', label: 'a_b.ts', value: 'src/a_b.ts' })
      }
    })
  }, [editor])

  return (
    <div style={{ height: '100vh', boxSizing: 'border-box', padding: 24, background: 'var(--gren-content-bg)' }}>
      <CommandPillHostContext.Provider value={host}>
        <div data-testid="composer" style={{ minHeight: 120, padding: 12, borderRadius: 12, border: '1px solid var(--ant-color-border-secondary)' }}>
          <Editor
            editor={editor}
            content=""
            type="text"
            variant="chat"
            pasteAsPlainText
            enablePasteMarkdown={false}
            markdownOption={false}
            plugins={[ReactChatTagPlugin, ReactCommandPillPlugin]}
            onPressEnter={({ event }) => {
              if (event.shiftKey || event.isComposing) return
              event.preventDefault()
              host.submit()
              return true
            }}
          />
        </div>
      </CommandPillHostContext.Provider>
    </div>
  )
}
