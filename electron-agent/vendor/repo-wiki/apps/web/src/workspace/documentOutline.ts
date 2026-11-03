import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
export type OutlineHeading = {
  id: string;
  title: string;
  level: number;
  line: number;
};
type AstNode = {
  type: string;
  value?: string;
  alt?: string;
  depth?: number;
  children?: AstNode[];
  position?: { start: { line: number } };
};
const parser = unified().use(remarkParse).use(remarkGfm);
const plain = (node: AstNode): string =>
  node.type === "html"
    ? ""
    : (node.value ?? node.alt ?? node.children?.map(plain).join("") ?? "");
/** The same Markdown/GFM parser as the reader, with source-line anchors. */
export function documentOutline(
  markdown: string,
  prefix = "wiki-heading",
): OutlineHeading[] {
  const result: OutlineHeading[] = [];
  const visit = (node: AstNode) => {
    if (result.length >= 200) return;
    if (node.type === "heading" && node.position) {
      const line = node.position.start.line;
      result.push({
        id: `${prefix}-${line}`,
        title: plain(node),
        level: node.depth || 1,
        line,
      });
    }
    node.children?.forEach(visit);
  };
  visit(parser.parse(markdown) as AstNode);
  return result;
}
