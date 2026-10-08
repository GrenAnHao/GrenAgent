import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Editor, useEditor } from '@lobehub/editor/react'
import { buildCommandBlock } from '@extensions/prompt-commands/syntax'
import ReactChatTagPlugin from '../../src/features/chat/input/editor/ChatTag/ReactChatTagPlugin'
import ReactCommandPillPlugin from '../../src/features/chat/input/editor/CommandPill/ReactCommandPillPlugin'
import { CommandPillHostContext } from '../../src/features/chat/input/editor/CommandPill/hostContext'
import { INSERT_COMMAND_PILL_COMMAND } from '../../src/features/chat/input/editor/CommandPill/commands'
import { focusMissingPillArg, readComposerText } from '../../src/features/chat/input/editor/CommandPill/composerText'
import { loadPromptCommands } from '../../src/features/chat/input/editor/promptCommandCache'
import { renderMessageTags } from '../../src/features/chat/messageTags'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

/**
 * 命令胶囊：真实 lobehub Editor + CommandPill 插件。插入走 INSERT_COMMAND_PILL_COMMAND（和斜杠菜单 onSelect 同一条命令），
 * 发送走 readComposerText，拦截走 focusMissingPillArg。下面三个气泡：command 块、刚发出的调用文本、无参数命令后跟正文。
 */

const REFACTOR = {
  name: 'refactor',
  description: '按指定风格重构文件',
  body: '请把 {file} 重构成 {style=functional} 风格。',
  params: [{ name: 'file' }, { name: 'style', defaultValue: 'functional' }],
  path: '/agent/prompts/refactor.md'
}

installBridge({
  invoke: async (command: string) => {
    if (command === 'list_prompt_commands') return [REFACTOR]
    throw new Error(`unstubbed invoke: ${command}`)
  }
})

const BLOCK = buildCommandBlock(
  'refactor',
  [{ name: 'file', value: 'src/a.ts' }, { name: 'style', value: 'functional' }],
  '请把 src/a.ts 重构成 functional 风格。'
)

exposeData({ blockBody: '请把 src/a.ts 重构成 functional 风格。' })

const bubble = { alignSelf: 'flex-end', maxWidth: '80%', padding: '8px 12px', borderRadius: 14, background: 'var(--ant-color-fill-secondary)', whiteSpace: 'pre-wrap' } as const

export default function CommandPillScenario(): ReactElement {
  const editor = useEditor()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    void loadPromptCommands().then(() => setReady(true))
  }, [])

  const host = useMemo(() => ({
    submit: () => {
      if (focusMissingPillArg(editor.getLexicalEditor())) {
        track('blocked')
        return
      }
      track(`send:${readComposerText(editor)}`)
    }
  }), [editor])

  useEffect(() => {
    exposeActions({
      insertRefactor: () => {
        editor.focus()
        editor.dispatchCommand(INSERT_COMMAND_PILL_COMMAND, { name: REFACTOR.name, params: REFACTOR.params })
      },
      clear: () => editor.cleanDocument()
    })
  }, [editor])

  return (
    <div style={{ height: '100vh', boxSizing: 'border-box', padding: 24, display: 'flex', flexDirection: 'column', gap: 16, background: 'var(--gren-content-bg)' }}>
      <CommandPillHostContext.Provider value={host}>
        <div data-testid="composer" style={{ minHeight: 72, padding: 12, borderRadius: 12, border: '1px solid var(--ant-color-border-secondary)' }}>
          <Editor
            editor={editor}
            content=""
            type="text"
            variant="chat"
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
      {ready ? (
        <>
          <div data-testid="bubble-block" style={bubble}>{renderMessageTags(`${BLOCK}\n\n顺便加测试`)}</div>
          <div data-testid="bubble-optimistic" style={bubble}>{renderMessageTags('/refactor "src/b.ts" ""')}</div>
          <div data-testid="bubble-plain" style={bubble}>{renderMessageTags('/review 顺便看看错误处理')}</div>
        </>
      ) : null}
    </div>
  )
}
