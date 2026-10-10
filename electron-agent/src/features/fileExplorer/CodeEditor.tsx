import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  LanguageDescription,
  syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { unifiedMergeView } from '@codemirror/merge';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { cssVar } from 'antd-style';
import { useEffect, useRef } from 'react';
import { baseName, fileKindOf, type LineSeparator } from './fileKinds';

export interface CodeEditorProps {
  path: string;
  /** 变了才把 value 整份装进编辑器（换文件 / 重新载入 / 放弃修改），其余时候文档归编辑器自己。 */
  docVersion: number;
  value: string;
  /** 「对比」时作为原文。 */
  original: string;
  readOnly: boolean;
  showDiff: boolean;
  lineSeparator: LineSeparator;
  /** 大文件：关掉折叠、括号匹配这类重扩展，改动合并着上报。 */
  large: boolean;
  isDark: boolean;
  onChange: (doc: string) => void;
}

/** 大文件每次按键都 toString 整份文档太贵，合并到这个间隔里上报一次。 */
const LARGE_CHANGE_THROTTLE_MS = 200;

function themeExtension(isDark: boolean): Extension {
  return [
    EditorView.theme(
      {
        '&': { height: '100%', fontSize: '13px', color: cssVar.colorText, backgroundColor: 'transparent' },
        '&.cm-focused': { outline: 'none' },
        '.cm-scroller': { fontFamily: cssVar.fontFamilyCode, lineHeight: '1.6' },
        '.cm-content': { caretColor: cssVar.colorText },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: cssVar.colorText },
        '.cm-gutters': { backgroundColor: 'transparent', color: cssVar.colorTextQuaternary, border: 'none' },
        '.cm-activeLine': { backgroundColor: cssVar.colorFillQuaternary },
        '.cm-activeLineGutter': { backgroundColor: 'transparent', color: cssVar.colorTextSecondary },
        '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
          { backgroundColor: cssVar.controlItemBgActive },
        '.cm-searchMatch': { backgroundColor: cssVar.colorWarningBg, outline: `1px solid ${cssVar.colorWarningBorder}` },
        '.cm-panels': { backgroundColor: cssVar.colorBgElevated, color: cssVar.colorText },
        '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${cssVar.colorBorderSecondary}` },
        '.cm-foldPlaceholder': { backgroundColor: cssVar.colorFillSecondary, border: 'none', color: cssVar.colorTextSecondary },
      },
      { dark: isDark },
    ),
    syntaxHighlighting(isDark ? oneDarkHighlightStyle : defaultHighlightStyle),
  ];
}

function baseExtensions(large: boolean): Extension {
  const light = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    keymap.of([indentWithTab, ...defaultKeymap, ...searchKeymap, ...historyKeymap]),
  ];
  if (large) return light;
  return [
    ...light,
    foldGutter(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([...closeBracketsKeymap, ...foldKeymap]),
  ];
}

function readOnlyExtension(readOnly: boolean): Extension {
  // 只读仍可选中、复制、搜索；只是不让改。
  return EditorState.readOnly.of(readOnly);
}

function diffExtension(showDiff: boolean, original: string): Extension {
  return showDiff ? unifiedMergeView({ original, mergeControls: false, gutter: true }) : [];
}

async function loadLanguage(path: string): Promise<Extension | null> {
  if (fileKindOf(path) === 'markdown') return markdown({ codeLanguages: languages });
  const description = LanguageDescription.matchFilename(languages, baseName(path));
  return description ? description.load() : null;
}

/**
 * CodeMirror 6 编辑器。只读 / 编辑、明暗主题、对比都放在 Compartment 里原地重配，不重建编辑器；
 * 只有换文件（docVersion 变）时换一份新的 EditorState，撤销历史随之清空。
 */
export default function CodeEditor(props: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const compartments = useRef({
    readOnly: new Compartment(),
    theme: new Compartment(),
    language: new Compartment(),
    diff: new Compartment(),
    lineSeparator: new Compartment(),
  }).current;
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const createState = (p: CodeEditorProps): EditorState =>
    EditorState.create({
      doc: p.value,
      extensions: [
        baseExtensions(p.large),
        compartments.lineSeparator.of(EditorState.lineSeparator.of(p.lineSeparator)),
        compartments.readOnly.of(readOnlyExtension(p.readOnly)),
        compartments.theme.of(themeExtension(p.isDark)),
        compartments.language.of([]),
        compartments.diff.of(diffExtension(p.showDiff, p.original)),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const report = () => {
            throttleRef.current = null;
            const view = viewRef.current;
            // doc.toString() 一律用 LF 拼行；sliceDoc 才按 lineSeparator 拼，CRLF 文件保存后不变。
            if (view) propsRef.current.onChange(view.state.sliceDoc());
          };
          if (!propsRef.current.large) {
            report();
          } else if (!throttleRef.current) {
            throttleRef.current = setTimeout(report, LARGE_CHANGE_THROTTLE_MS);
          }
        }),
      ],
    });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const view = new EditorView({ state: createState(propsRef.current), parent: host });
    viewRef.current = view;
    return () => {
      if (throttleRef.current) clearTimeout(throttleRef.current);
      view.destroy();
      viewRef.current = null;
    };
    // 编辑器只在挂载时建一次；后面的变化都由下面几个 effect 原地重配。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 换文件 / 重新载入：整份换状态（首次挂载时文档已经是 value，跳过）。
  const loadedVersion = useRef(props.docVersion);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || loadedVersion.current === props.docVersion) return;
    loadedVersion.current = props.docVersion;
    if (throttleRef.current) {
      clearTimeout(throttleRef.current);
      throttleRef.current = null;
    }
    view.setState(createState(propsRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.docVersion]);

  useEffect(() => {
    let cancelled = false;
    loadLanguage(props.path)
      .then((language) => {
        if (cancelled || !viewRef.current) return;
        viewRef.current.dispatch({ effects: compartments.language.reconfigure(language ?? []) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [props.path, props.docVersion, compartments]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.readOnly.reconfigure(readOnlyExtension(props.readOnly)) });
  }, [props.readOnly, compartments]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.theme.reconfigure(themeExtension(props.isDark)) });
  }, [props.isDark, compartments]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.diff.reconfigure(diffExtension(props.showDiff, props.original)) });
  }, [props.showDiff, props.original, compartments]);

  return <div ref={hostRef} data-testid="file-code-editor" style={{ height: '100%', minHeight: 0, overflow: 'hidden' }} />;
}
