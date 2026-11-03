import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WikiTree, buildWikiTree } from "./WikiTree";
import { documentOutline } from "./documentOutline";
import { Markdown } from "./Markdown";
import type { WikiPage } from "./api";
const pages = ["overview", "modules/core", "modules/api", "guides/start"].map(
  (id) => ({
    id,
    title: id,
    status: id === "modules/core" ? "conflict" : "ready",
    markdown: "",
    sources: [],
    revision: 1,
  }),
) as WikiPage[];
describe("document workspace navigation", () => {
  it("matches the real Markdown AST for multiline setext, quoted headings and indented code", () => {
    const text =
      "First line\nSecond line\n---\n\n    indented code\n---\n\n> ## Quoted";
    const outline = documentOutline(text);
    expect(outline.map((h) => h.line)).toEqual([1, 8]);
    expect(outline[0].title).toBe("First line\nSecond line");
    render(<Markdown value={text} onSource={() => {}} onPage={() => {}} />);
    expect(
      screen.getByRole("heading", { name: /First line\s+Second line/ }),
    ).toHaveAttribute("id", outline[0].id);
    expect(screen.getByRole("heading", { name: "Quoted" })).toHaveAttribute(
      "id",
      outline[1].id,
    );
  });
  it("groups actual page paths without fabricating dependency parents", () => {
    const nodes = buildWikiTree(pages);
    expect(nodes.map((n) => n.key)).toEqual(["overview", "modules", "guides"]);
    expect(nodes[1].children.map((n) => n.page?.id)).toEqual([
      "modules/core",
      "modules/api",
    ]);
  });
  it("collapses, searches descendants, and opens exact page ids", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <WikiTree
        pages={pages}
        selectedId="overview"
        query=""
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("treeitem", { name: "核心模块" }));
    expect(screen.queryByRole("treeitem", { name: /modules\/api/ })).toBeNull();
    rerender(
      <WikiTree
        pages={pages}
        selectedId="overview"
        query="api"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("treeitem", { name: /modules\/api/ }));
    expect(onSelect).toHaveBeenCalledWith("modules/api");
    expect(screen.queryByRole("treeitem", { name: "overview" })).toBeNull();
  });
  it("supports roving keyboard focus and parent navigation", () => {
    render(
      <WikiTree
        pages={pages}
        selectedId="overview"
        query=""
        onSelect={() => {}}
      />,
    );
    const overview = screen.getByRole("treeitem", { name: "overview" });
    overview.focus();
    fireEvent.keyDown(overview, { key: "ArrowDown" });
    const group = screen.getByRole("treeitem", { name: "核心模块" });
    expect(group).toHaveFocus();
    fireEvent.keyDown(group, { key: "ArrowRight" });
    const child = screen.getByRole("treeitem", { name: /modules\/core/ });
    expect(child).toHaveFocus();
    fireEvent.keyDown(child, { key: "ArrowLeft" });
    expect(group).toHaveFocus();
  });
  it("excludes fenced headings, supports setext, and uses source-line anchors", () => {
    const text =
      "# Overview\n\n```md\n# not a heading\n```\n\n## **Details**\n\nSetup\n---";
    expect(documentOutline(text, "panel")).toEqual([
      { id: "panel-1", title: "Overview", level: 1, line: 1 },
      { id: "panel-7", title: "Details", level: 2, line: 7 },
      { id: "panel-9", title: "Setup", level: 2, line: 9 },
    ]);
    render(
      <Markdown
        value={text}
        headingPrefix="panel"
        onSource={() => {}}
        onPage={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: "Details" })).toHaveAttribute(
      "id",
      "panel-7",
    );
    expect(screen.getByRole("heading", { name: "Setup" })).toHaveAttribute(
      "id",
      "panel-9",
    );
  });
});
