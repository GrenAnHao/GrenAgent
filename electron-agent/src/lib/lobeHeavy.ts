/**
 * @lobehub/ui 里只有对话内容、工具卡出现后才用到的重组件。
 *
 * 要按需加载就 `import('…/lib/lobeHeavy')`，不要 `import('@lobehub/ui')`：对整个包做动态导入时，
 * 打包器得把返回的命名空间整份备齐，而这个包又被首屏静态引用着，于是 Markdown（katex、rehype、
 * octicons）、Mermaid（elkjs）、EmojiPicker 等全部留在首包里。经这份文件中转，只有这里点名的组件
 * 及其依赖进按需分块。
 */
export { CodeDiff, Highlighter, Markdown, PatchDiff, SyntaxHighlighter } from '@lobehub/ui';
