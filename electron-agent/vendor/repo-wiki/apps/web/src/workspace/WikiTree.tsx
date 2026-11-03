import { useEffect, useMemo, useRef, useState } from "react";
import type { WikiPage } from "./api";
import { Icon } from "./Icons";

type Node = { key: string; label: string; page?: WikiPage; children: Node[] };
type Section = { id: string; parentId?: string; ordinal?: number; sectionName?: string; title?: string };
const groupLabels: Record<string, string> = {
  modules: "核心模块",
  architecture: "架构设计",
  guides: "开发指南",
  api: "API 参考",
};
/** Page paths, not dependency edges, define this navigation hierarchy. */
export function buildWikiTree(pages: WikiPage[], catalogue: Section[] = []): Node[] {
  const roots: Node[] = [];
  const sections = catalogue.length ? catalogue : pages.filter(page => page.native_section).map(page => ({ id: page.id, title: page.title, ...page.native_section }));
  const native = new Map<string, Node>(sections.map(section => [section.id, { key: section.id, label: section.sectionName ?? section.title ?? section.id, page: pages.find(page => page.id === section.id), children: [] }]));
  for (const section of [...sections].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))) {
    const node = native.get(section.id)!;
    const ancestors = new Set([section.id]); let parentId = section.parentId;
    while (parentId) { if (ancestors.has(parentId)) throw new Error('Invalid native catalogue hierarchy'); ancestors.add(parentId); parentId = sections.find(item => item.id === parentId)?.parentId; }
    const parent = section.parentId ? native.get(section.parentId) : undefined;
    (parent?.children ?? roots).push(node);
  }
  for (const page of pages.filter(page => !native.has(page.id))) {
    let siblings = roots;
    const parts = page.id.split("/");
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(0, i + 1).join("/");
      let node = siblings.find((item) => item.key === key);
      if (!node) {
        node = { key, label: groupLabels[key] || parts[i], children: [] };
        siblings.push(node);
      }
      if (i === parts.length - 1) {
        node.page = page;
        node.label = page.title || page.id;
      }
      siblings = node.children;
    }
  }
  return roots;
}
export function WikiTree({
  pages,
  selectedId,
  query,
  onSelect,
  catalogue,
}: {
  pages: WikiPage[];
  selectedId: string;
  query: string;
  onSelect: (id: string) => void;
  catalogue?: Section[];
}) {
  const roots = useMemo(() => buildWikiTree(pages, catalogue), [pages, catalogue]);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [focus, setFocus] = useState(selectedId);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    setFocus(selectedId);
    setClosed(
      (previous) =>
        new Set(
          [...previous].filter((key) => {
            const node = (items: Node[]): Node | undefined => { for (const item of items) { if (item.key === key) return item; const nested = node(item.children); if (nested) return nested; } };
            const contains = (item: Node): boolean => item.key === selectedId || item.children.some(contains);
            const ancestor = node(roots); return ancestor ? !contains(ancestor) : !selectedId.startsWith(key + '/');
          }),
        ),
    );
  }, [selectedId, roots]);
  const match = (node: Node): boolean =>
    (node.label + " " + node.key).toLowerCase().includes(query.toLowerCase()) ||
    node.children.some(match);
  const rows: { node: Node; depth: number; parent?: string }[] = [];
  const visit = (nodes: Node[], depth: number, parent?: string) =>
    nodes.forEach((node) => {
      if (query && !match(node)) return;
      rows.push({ node, depth, parent });
      if (query || !closed.has(node.key))
        visit(node.children, depth + 1, node.key);
    });
  visit(roots, 1);
  const focused = rows.some((row) => row.node.key === focus)
    ? focus
    : rows[0]?.node.key;
  const move = (key?: string) => {
    if (key) {
      setFocus(key);
      buttons.current.get(key)?.focus();
    }
  };
  const toggle = (key: string) =>
    setClosed((previous) => {
      const next = new Set(previous);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  if (!rows.length)
    return (
      <div className="tree-empty">
        {query ? "没有匹配的页面" : "生成后将在这里显示文档目录"}
      </div>
    );
  return (
    <div className="wiki-tree" role="tree" aria-label="Wiki 文档目录">
      {rows.map(({ node, depth, parent }, index) => {
        const expanded =
          !!node.children.length && (!!query || !closed.has(node.key));
        return (
          <button
            type="button"
            key={node.key}
            ref={(el) => {
              if (el) buttons.current.set(node.key, el);
              else buttons.current.delete(node.key);
            }}
            role="treeitem"
            aria-level={depth}
            aria-selected={selectedId === node.page?.id}
            aria-expanded={node.children.length ? expanded : undefined}
            tabIndex={focused === node.key ? 0 : -1}
            className={`tree-row ${selectedId === node.page?.id ? "active" : ""} ${node.page?.status === "archived" ? "archived" : ""}`}
            style={{ paddingLeft: 8 + (depth - 1) * 16 }}
            title={
              node.page ? `${node.page.title} · ${node.page.id}` : node.label
            }
            onFocus={() => setFocus(node.key)}
            onClick={() =>
              node.page ? onSelect(node.page.id) : toggle(node.key)
            }
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                move(rows[index + 1]?.node.key);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                move(rows[index - 1]?.node.key);
              } else if (event.key === "Home") {
                event.preventDefault();
                move(rows[0]?.node.key);
              } else if (event.key === "End") {
                event.preventDefault();
                move(rows[rows.length - 1]?.node.key);
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                if (node.children.length) {
                  if (!expanded) toggle(node.key);
                  else move(rows[index + 1]?.node.key);
                }
              } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                if (expanded && !query) toggle(node.key);
                else move(parent);
              }
            }}
          >
            <span
              className={`tree-chevron ${expanded ? "expanded" : ""}`}
              onClick={(event) => {
                if (node.children.length) {
                  event.stopPropagation();
                  toggle(node.key);
                }
              }}
            >
              {node.children.length ? (
                <Icon name="chevron" size={12} />
              ) : (
                <Icon name="file" size={13} />
              )}
            </span>
            <span className="tree-label">{node.label}</span>
            {node.page?.status === "conflict" && (
              <span className="tree-status conflict" aria-label="待解决冲突">
                !
              </span>
            )}
            {node.page?.status === "edited" && (
              <span className="tree-status edited" aria-label="人工修订">
                ●
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
