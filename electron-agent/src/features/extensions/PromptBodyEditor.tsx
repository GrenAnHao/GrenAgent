import { createStaticStyles, cssVar } from 'antd-style';
import { useRef } from 'react';
import { libraryStyles } from './libraryStyles';
import { parsePromptParams, tokenizePromptBody } from '@extensions/prompt-commands/syntax';

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 160px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};

    &:focus-within {
      border-color: ${cssVar.colorPrimary};
    }
  `,
  layer: css`
    margin: 0;
    padding: 8px 10px;
    font-family: ${cssVar.fontFamilyCode};
    font-variant-ligatures: none;
    font-size: 13.5px;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-word;
    scrollbar-gutter: stable;
  `,
  backdrop: css`
    position: absolute;
    inset: 0;
    overflow: hidden;
    color: ${cssVar.colorText};
    pointer-events: none;
  `,
  param: css`
    border-radius: 3px;
    color: ${cssVar.colorPrimary};
    background: color-mix(in srgb, ${cssVar.colorPrimary} 14%, transparent);
  `,
  textarea: css`
    position: relative;
    display: block;
    flex: 1;
    width: 100%;
    min-height: 0;
    resize: none;
    border: 0;
    outline: none;
    color: transparent;
    caret-color: ${cssVar.colorText};
    background: transparent;

    &::placeholder {
      color: ${cssVar.colorTextQuaternary};
    }
  `,
}));

/** 提示词编辑框：{参数} 在背景层高亮，前景 textarea 负责输入。 */
export function PromptBodyEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  function insert(text: string) {
    const field = input.current;
    if (!field) return;
    const start = field.selectionStart;
    onChange(value.slice(0, start) + text + value.slice(field.selectionEnd));
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start + text.length, start + text.length); });
  }
  const inserts = [
    {label:'$ARGUMENTS', text:'$ARGUMENTS', hint:'调用时斜杠命令后的全部参数；不与命名参数混用', disabled:!!parsePromptParams(value).length},
    {label:'@file', text:'@{文件}', hint:'调用时填写文件路径，Agent 按路径读取；不与 $ARGUMENTS 混用', disabled:value.includes('$ARGUMENTS')},
    {label:'Git Diff', text:'读取当前工作区的 git diff，并以实际差异为准。', hint:'让 Agent 在调用时读取工作区差异'},
  ];
  return (<>
    <div className={libraryStyles.params} aria-label="插入模板片段"><span>插入</span>{inserts.map((item) =>
      <button type="button" className={libraryStyles.modeChip} key={item.label} title={item.hint} disabled={item.disabled}
        onMouseDown={(event) => event.preventDefault()} onClick={() => insert(item.text)}>{item.label}</button>)}</div>
    <div className={styles.wrap}>
      <div ref={backdropRef} className={`${styles.layer} ${styles.backdrop}`} aria-hidden>
        {tokenizePromptBody(value).map((segment, index) =>
          segment.param ? (
            <mark key={index} className={styles.param}>{segment.text}</mark>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
        {/* 末尾换行时补一个字符，背景层高度才和 textarea 一致 */}
        {String.fromCharCode(0x200b)}
      </div>
      <textarea ref={input}
        className={`${styles.layer} ${styles.textarea}`}
        data-testid="prompt-body-input"
        aria-label="提示词"
        value={value}
        spellCheck={false}
        placeholder="用 {参数名} 留空，{参数名=默认值} 带默认"
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (backdropRef.current) backdropRef.current.scrollTop = event.currentTarget.scrollTop;
        }}
      />
    </div></>
  );
}
