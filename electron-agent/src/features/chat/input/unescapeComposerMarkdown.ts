/**
 * @lobehub/editor 的 getDocument('markdown') 会经 remark-gfm 再格式化：
 * `_` → `\_`，邮箱 `a@b.com` → `<a@b.com>`（GFM autolink），有时 `@` → `\@`。
 * 发给模型 / 展示给用户时这些转义没有意义，这里还原。
 */
export function unescapeComposerMarkdown(markdown: string): string {
  return markdown
    .replace(/\\_/g, '_')
    .replace(/\\@/g, '@')
    .replace(/<([^<>\s]+@[^<>\s]+)>/g, (full, inner: string) =>
      inner.includes('://') ? full : inner,
    );
}
