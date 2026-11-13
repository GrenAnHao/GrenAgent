import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { defaultKeymap } from '@codemirror/commands';
import { defaultHighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { Decoration, EditorView, drawSelection, highlightSpecialChars, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import { cssVar, useThemeMode } from 'antd-style';
import { codeStyles as styles } from './codeStyles';

export interface CodeSourceLinesHandle {
  /** 把第 line 行（从 1 起）滚到预览中间；行不在文件里就什么都不做。 */
  scrollToLine(line: number): void;
}

interface CodeSourceLinesProps { lines: string[]; /** 高亮成当前位置的行（从 1 起） */ target?: number; /** 供语言识别的文件路径 */ path?: string }

const setTargetLine = StateEffect.define<number | null>();

const targetLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) if (effect.is(setTargetLine)) {
      if (effect.value == null) next = Decoration.none;
      else {
        const line = Math.min(Math.max(1, effect.value), tr.state.doc.lines);
        next = Decoration.set([Decoration.line({ class: 'cm-target-line' }).range(tr.state.doc.line(line).from)]);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function themeExtension(isDark: boolean): Extension {
  return [
    EditorView.theme(
      {
        '&': { height: '100%', fontSize: '12px', color: cssVar.colorText, backgroundColor: 'transparent' },
        '&.cm-focused': { outline: 'none' },
        '.cm-scroller': { fontFamily: cssVar.fontFamilyCode, lineHeight: '1.7' },
        // 行号栏必须不透明：横向滚动时代码从栏下穿过，透明底会让行号叠在代码上。
        '.cm-gutters': { backgroundColor: cssVar.colorBgContainer, color: cssVar.colorTextQuaternary, border: 'none' },
        '.cm-target-line': { backgroundColor: cssVar.colorPrimaryBg, boxShadow: `inset 2px 0 ${cssVar.colorPrimary}` },
        '.cm-selectionBackground, .cm-content ::selection': { backgroundColor: cssVar.controlItemBgActive },
      },
      { dark: isDark },
    ),
    syntaxHighlighting(isDark ? oneDarkHighlightStyle : defaultHighlightStyle),
  ];
}

/**
 * 只读源码预览：CodeMirror 6，语法高亮 + 行号，目标行橄榄绿强调。
 * 滚动容器是 CM 自己的 scroller，长文件天然只画可视窗口；高度由外层 flex 铺满。
 */
export const CodeSourceLines = forwardRef<CodeSourceLinesHandle, CodeSourceLinesProps>(function CodeSourceLines({ lines, target, path }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const { isDarkMode } = useThemeMode();
  const darkRef = useRef(isDarkMode);
  darkRef.current = isDarkMode;
  const compartments = useRef({ theme: new Compartment(), language: new Compartment() }).current;
  const doc = lines.join('\n');
  const docRef = useRef(doc);
  docRef.current = doc;

  useImperativeHandle(ref, () => ({
    scrollToLine(line) {
      const current = view.current;
      if (!current || line < 1 || line > current.state.doc.lines) return;
      current.dispatch({ effects: EditorView.scrollIntoView(current.state.doc.line(line).from, { y: 'center' }) });
    },
  }), []);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return undefined;
    const editor = new EditorView({
      state: EditorState.create({
        doc: docRef.current,
        extensions: [
          lineNumbers(),
          highlightSpecialChars(),
          drawSelection(),
          keymap.of(defaultKeymap),
          EditorState.readOnly.of(true),
          targetLineField,
          compartments.theme.of(themeExtension(darkRef.current)),
          compartments.language.of([]),
        ],
      }),
      parent,
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, [compartments]);

  // 换文件：整份替换文档但保留扩展与语言；目标行装饰随 changes 映射。
  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === doc) return;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: doc } });
  }, [doc]);

  useEffect(() => {
    view.current?.dispatch({ effects: setTargetLine.of(target ?? null) });
  }, [target, doc]);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.theme.reconfigure(themeExtension(isDarkMode)) });
  }, [isDarkMode, compartments]);

  useEffect(() => {
    let cancelled = false;
    const description = path ? LanguageDescription.matchFilename(languages, path.replace(/\\/g, '/').split('/').pop() ?? path) : undefined;
    if (!description) return undefined;
    description.load()
      .then((language) => { if (!cancelled) view.current?.dispatch({ effects: compartments.language.reconfigure(language) }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path, compartments]);

  return <div ref={host} className={styles.sourceViewer} aria-label="源码内容" />;
});