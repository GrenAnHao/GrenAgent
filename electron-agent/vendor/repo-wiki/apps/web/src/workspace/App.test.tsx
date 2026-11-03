import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import App from "../App";
const source = {
  path: "src/main.ts",
  start_line: 1,
  end_line: 2,
  hash: "original",
};
const wikiPages = Array.from({ length: 10 }, (_, i) => ({
  id: i === 0 ? "overview" : `modules/topic-${i}`,
  title: i === 0 ? "项目概览" : `主题 ${i}`,
  markdown: `# ${i === 0 ? "项目概览" : `主题 ${i}`}\n\n## 实际章节\n\n[main.ts](source:src/main.ts#L1-L2)`,
  baseline: "baseline",
  status: "ready",
  revision: 1,
  sources: [source],
  identity: { branch: "main", commit: "abcdef1234" },
  updated_at: "2026-10-31T04:00:00Z",
}));
const card = {
  ...wikiPages[0],
  id: "cards/design",
  title: "任务设计约束",
  kind: "card",
  category: "架构设计",
  summary: "这是独立保存的设计卡片，不是 Wiki 页面。",
};
const baseProject = {
  id: "atlas",
  name: "Atlas",
  path: "/example/atlas",
  language: "zh",
  watch: false,
  plan: { pages: wikiPages.map((p) => ({ id: p.id, title: p.title })) },
  identity: { branch: "main", commit: "abcdef1234" },
  pages: wikiPages,
  cards: [card],
  page_count: 10,
  card_count: 1,
  knowledge: {
    wiki: {
      count: 10,
      identity: { commit: "abcdef1234" },
      updated_at: "2026-10-31T04:00:00Z",
    },
    cards: {
      count: 1,
      identity: { commit: "abcdef1234" },
      updated_at: "2026-10-31T04:05:00Z",
    },
  },
  stats: { files: 2 },
};
function mockApi(
  options: {
    run?: Record<string, any>;
    errorGenerate?: boolean;
    empty?: boolean;
    project?: Record<string, any>;
  } = {},
) {
  let project: any = { ...structuredClone(baseProject), ...options.project };
  if (options.empty) {
    project.pages = [];
    project.cards = [];
    project.page_count = 0;
    project.card_count = 0;
    project.knowledge = { wiki: { count: 0 }, cards: { count: 0 } };
  }
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), "http://local.test");
    let data: any = {};
    let status = 200;
    const path = url.pathname;
    if (path.endsWith("/health"))
      data = {
        status: "ok",
        demo_path: "/example/atlas",
        provider: { real_configured: true },
      };
    else if (path.endsWith("/projects")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        data = {
          ...project,
          id: body.language === "en" ? "atlas-en" : "atlas",
          language: body.language,
          pages: body.language === "en" ? [] : project.pages,
          cards: body.language === "en" ? [] : project.cards,
        };
      } else data = [project];
    } else if (path.endsWith("/changes"))
      data = {
        changed: [],
        added: options.empty ? ["new.ts"] : [],
        deleted: [],
        affected_pages: [],
      };
    else if (path.endsWith("/runs/latest"))
      data = options.run || { status: "idle" };
    else if (path.includes("/pages/")) {
      const slug = decodeURIComponent(path.split("/pages/")[1]);
      const page = [...project.pages, ...project.cards].find(
        (item) => item.id === slug,
      );
      data =
        init?.method === "PUT"
          ? {
              ...page,
              markdown: JSON.parse(String(init.body)).markdown,
              revision: 2,
              status: "edited",
            }
          : page;
    } else if (path.endsWith("/source"))
      data = {
        path: "src/main.ts",
        content: "first\nsecond",
        total_lines: 2,
        start_line: 1,
        end_line: 2,
        hash: "changed",
      };
    else if (path.endsWith("/generate")) {
      const body = JSON.parse(String(init?.body));
      data = options.errorGenerate
        ? { detail: "Real generation is disabled" }
        : { run_id: "r1", status: "queued", target: body.target };
      status = options.errorGenerate ? 400 : 200;
    } else if (path.endsWith("/cancel"))
      data = { run_id: "r1", status: "cancel_requested" };
    else if (path.endsWith("/plan")) {
      project.plan = JSON.parse(String(init?.body)).plan;
      data = project;
    } else data = project;
    return { ok: status === 200, status, json: async () => data };
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
async function openProject() {
  fireEvent.click(
    await screen.findByRole("button", { name: "打开项目 Atlas" }),
  );
  await screen.findByRole("heading", { name: "Repo Wiki 概览" });
}
async function openDoc(name = "项目概览") {
  fireEvent.click(await screen.findByRole("treeitem", { name }));
  await screen.findAllByRole("heading", { name });
}
function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "更多 Wiki 操作" }));
  return screen.getByRole("menu", { name: "Wiki 操作" });
}
beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("collection, independent overview, cards and document routes", () => {
  it("starts at the project collection and only loads a project after explicit selection", async () => {
    const fetch = mockApi();
    const view = render(<App />);
    await screen.findByRole("button", { name: "打开项目 Atlas" });
    expect(
      screen.getByRole("region", { name: "Repo Wiki 项目集合" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(
      fetch.mock.calls.some(([url]) => String(url).endsWith("/projects/atlas")),
    ).toBe(false);
    await openProject();
    expect(
      screen.getByRole("heading", { name: "Repo Wiki 概览" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "项目概览" }),
    ).not.toBeInTheDocument();
    expect(view.container.querySelector(".stats-row")).toBeNull();
  });
  it("keeps the overview pseudo-route distinct from the overview Markdown document and supports returning to collection", async () => {
    mockApi();
    render(<App />);
    await openProject();
    await openDoc();
    fireEvent.click(screen.getByRole("button", { name: /Repo Wiki 概览/ }));
    expect(
      screen.getByRole("heading", { name: "Repo Wiki 概览" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Markdown 编辑器")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "返回 Repo Wiki 项目集合" }),
    );
    expect(
      await screen.findByRole("button", { name: "打开项目 Atlas" }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe("");
  });
  it("shows separate cards and sends target=cards only after explicit generation", async () => {
    const fetch = mockApi();
    render(<App />);
    await openProject();
    fireEvent.click(
      screen.getByRole("button", { name: "知识卡片", exact: true } as any),
    );
    await screen.findByRole("heading", { name: "知识卡片概览" });
    expect(
      screen.getByRole("navigation", { name: "知识卡片目录" }),
    ).toHaveTextContent("任务设计约束");
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith("/generate")),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith("/generate") &&
            JSON.parse(String(init?.body)).target === "cards",
        ),
      ).toBe(true),
    );
  });
  it("opens independent card content using its existing cards/ document ID", async () => {
    const fetch = mockApi();
    render(<App />);
    await openProject();
    fireEvent.click(
      screen.getByRole("button", { name: "知识卡片", exact: true } as any),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /任务设计约束/ }),
    );
    await screen.findByRole("heading", { name: "任务设计约束" });
    expect(
      fetch.mock.calls.some(([url]) =>
        String(url).includes("/pages/cards/design"),
      ),
    ).toBe(true);
  });
  it("opens, selects and closes bounded document tabs, protecting unsaved edits", async () => {
    mockApi();
    render(<App />);
    await openProject();
    await openDoc();
    await openDoc("主题 1");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    fireEvent.click(screen.getByRole("tab", { name: "项目概览" }));
    await screen.findAllByRole("heading", { name: "项目概览" });
    fireEvent.click(screen.getByRole("button", { name: "编辑文档" }));
    fireEvent.change(screen.getByLabelText("Markdown 编辑器"), {
      target: { value: "human draft" },
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "关闭文档 项目概览" }));
    expect(screen.getByLabelText("Markdown 编辑器")).toHaveValue("human draft");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });
  it("bounds open tabs at eight without making the current page disappear", async () => {
    mockApi();
    render(<App />);
    await openProject();
    await openDoc();
    for (let i = 1; i < 10; i++) await openDoc(`主题 ${i}`);
    expect(screen.getAllByRole("tab")).toHaveLength(8);
    expect(
      screen.getAllByRole("heading", { name: "主题 9" })[0],
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭文档 主题 9" }));
    await screen.findAllByRole("heading", { name: "主题 8" });
  });
  it("does not clear a page when the same tree item is selected repeatedly", async () => {
    mockApi();
    render(<App />);
    await openProject();
    await openDoc();
    fireEvent.click(screen.getByRole("treeitem", { name: "项目概览" }));
    expect(
      screen.getAllByRole("heading", { name: "项目概览" })[0],
    ).toBeInTheDocument();
  });
  it("shows initial language spaces as ungenerated rather than stale old documents", async () => {
    mockApi({ empty: true });
    render(<App />);
    await openProject();
    expect(
      screen.getByRole("button", { name: "生成文档" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/源码有/)).not.toBeInTheDocument();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
  });
});

describe("real controls and safe editing remain functional", () => {
  it("requires explicit external-source confirmation before real generation", async () => {
    const fetch = mockApi();
    render(<App />);
    await openProject();
    openMenu();
    fireEvent.change(screen.getByLabelText("生成模式"), {
      target: { value: "real" },
    });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    const dialog = await screen.findByRole("dialog", {
      name: "允许发送源码到模型服务？",
    });
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith("/generate")),
    ).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: /确认并生成/ }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith("/generate") &&
            JSON.parse(String(init?.body)).confirm_external === true,
        ),
      ).toBe(true),
    );
  });
  it("surfaces rejected real configuration inside the consent dialog", async () => {
    mockApi({ errorGenerate: true });
    render(<App />);
    await openProject();
    openMenu();
    fireEvent.change(screen.getByLabelText("生成模式"), {
      target: { value: "real" },
    });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /确认并生成/ }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Real generation is disabled",
    );
  });
  it("keeps Markdown synchronization separate from generation and navigates the menu by keyboard", async () => {
    const fetch = mockApi();
    render(<App />);
    await openProject();
    const menu = openMenu();
    expect(
      within(menu).getByRole("menuitem", { name: /Wiki 计划/ }),
    ).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(
      within(menu).getByRole("menuitemcheckbox", { name: "自动检测源码变更" }),
    ).toHaveFocus();
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "导入 Markdown 修订" }),
    );
    expect(
      screen.getByRole("dialog", { name: "导入 Markdown 修订" }),
    ).toBeInTheDocument();
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith("/generate")),
    ).toHaveLength(0);
  });
  it("supports source/preview and dismissible floating outline without mutating host routes", async () => {
    const fetch = mockApi();
    render(<App />);
    await openProject();
    await openDoc();
    const before = window.location.hash;
    fireEvent.click(
      screen.getByRole("button", { name: "源码", exact: true } as any),
    );
    expect(screen.getByLabelText("Markdown 源码")).toHaveTextContent(
      "# 项目概览",
    );
    expect(screen.queryByLabelText("Markdown 编辑器")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "预览", exact: true } as any),
    );
    fireEvent.click(screen.getByRole("button", { name: "打开页内目录" }));
    expect(
      screen.getByRole("navigation", { name: "页内目录" }),
    ).toHaveTextContent("实际章节");
    fireEvent.click(screen.getByRole("button", { name: "关闭信息面板" }));
    expect(
      screen.queryByRole("complementary", { name: "文档信息" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "实际章节" }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe(before);
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === "PUT"),
    ).toHaveLength(0);
  });
  it("warns when referenced source content has changed", async () => {
    mockApi();
    render(<App />);
    await openProject();
    await openDoc();
    fireEvent.click(screen.getAllByRole("button", { name: /main.ts/ })[0]);
    expect(await screen.findByText(/源文件已变化/)).toBeInTheDocument();
    expect(screen.getByText("first")).toBeInTheDocument();
  });
  it("switches language using a real namespace request but never automatically generates", async () => {
    const fetch = mockApi();
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith("/projects") &&
            init?.method === "POST" &&
            JSON.parse(String(init.body)).language === "en",
        ),
      ).toBe(true),
    );
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith("/generate")),
    ).toHaveLength(0);
  });
  it("cancels only after the in-flight HTTP/billing warning is confirmed", async () => {
    const fetch = mockApi({
      run: {
        status: "running",
        target: "wiki",
        message: "Generating",
        progress: 40,
      },
    });
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    const dialog = screen.getByRole("dialog", { name: "停止本次生成？" });
    expect(within(dialog).getByText(/可能已经产生费用/)).toBeInTheDocument();
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith("/cancel")),
    ).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "确认停止" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url]) => String(url).endsWith("/cancel")),
      ).toBe(true),
    );
  });
});

describe("namespace isolation, late responses and real navigation", () => {
  it("does not display an old branch completed run as generated in a new empty branch", async () => {
    mockApi({
      empty: true,
      project: {
        identity: { branch: "feature", language: "zh" },
        runs_by_kind: { wiki: { status: "idle" }, cards: { status: "idle" } },
      },
      run: {
        status: "completed",
        target: "cards",
        identity: { branch: "main", language: "zh" },
        result: { failed: 0 },
      },
    });
    render(<App />);
    await openProject();
    fireEvent.click(
      screen.getByRole("button", { name: "知识卡片", exact: true } as any),
    );
    const overview = await screen.findByRole("region", {
      name: "知识卡片概览",
    });
    expect(
      within(overview).getByRole("button", { name: "生成卡片" }),
    ).toBeInTheDocument();
    expect(within(overview).getByText("未生成")).toBeInTheDocument();
    expect(overview).not.toHaveTextContent("0 失败");
  });
  it("ignores a delayed generation response after external navigation to another project", async () => {
    const fetch = mockApi(),
      original = fetch.getMockImplementation()!;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/generate")) await pending;
      if (String(input).endsWith("/projects/beta"))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...baseProject,
            id: "beta",
            name: "Beta",
            path: "/example/beta",
            runs_by_kind: {
              wiki: { status: "idle" },
              cards: { status: "idle" },
            },
          }),
        };
      return original(input, init);
    });
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url]) => String(url).endsWith("/generate")),
      ).toBe(true),
    );
    window.history.pushState(null, "", "/#project=beta&mode=wiki");
    fireEvent.popState(window);
    await screen.findByText("Beta");
    await screen.findByRole("heading", { name: "Repo Wiki 概览" });
    await act(async () => release());
    expect(screen.queryByText("任务已加入队列")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "停止" }),
    ).not.toBeInTheDocument();
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith("/cancel")),
    ).toHaveLength(0);
  });
  it("asks explicitly for a real full regeneration and preserves the target and force intent", async () => {
    const fetch = mockApi();
    render(<App />);
    await openProject();
    fireEvent.click(
      screen.getByRole("button", { name: "知识卡片", exact: true } as any),
    );
    await screen.findByRole("heading", { name: "知识卡片概览" });
    const menu = openMenu();
    fireEvent.change(screen.getByLabelText("生成模式"), {
      target: { value: "real" },
    });
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "全量重新生成（绕过缓存）" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "允许发送源码到模型服务？",
    });
    expect(dialog).toHaveTextContent("将绕过已有模型结果缓存");
    expect(dialog).toHaveTextContent("知识卡片 · 全量");
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith("/generate")),
    ).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: /确认并生成/ }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith("/generate") &&
            JSON.parse(String(init?.body)).force === true &&
            JSON.parse(String(init?.body)).target === "cards" &&
            JSON.parse(String(init?.body)).confirm_external === true,
        ),
      ).toBe(true),
    );
  });
  it("invalidates real consent when the route changes before approval", async () => {
    const fetch = mockApi();
    render(<App />);
    await openProject();
    openMenu();
    fireEvent.change(screen.getByLabelText("生成模式"), {
      target: { value: "real" },
    });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    expect(
      screen.getByRole("dialog", { name: "允许发送源码到模型服务？" }),
    ).toBeInTheDocument();
    window.history.pushState(null, "", "/#project=atlas&mode=cards");
    fireEvent.popState(window);
    await screen.findByRole("heading", { name: "知识卡片概览" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith("/generate")),
    ).toHaveLength(0);
  });
  it("supports actual back and forward between overview and document without losing tabs", async () => {
    mockApi();
    render(<App />);
    await openProject();
    await openDoc();
    await act(async () => window.history.back());
    await screen.findByRole("heading", { name: "Repo Wiki 概览" });
    expect(screen.getByRole("tab", { name: "项目概览" })).toBeInTheDocument();
    await act(async () => window.history.forward());
    await screen.findByRole("heading", { name: "项目概览" });
  });
  it("restores the current hash when leaving an unsaved edit is rejected", async () => {
    mockApi();
    render(<App />);
    await openProject();
    await openDoc();
    fireEvent.click(screen.getByRole("button", { name: "编辑文档" }));
    fireEvent.change(screen.getByLabelText("Markdown 编辑器"), {
      target: { value: "unsaved branch notes" },
    });
    const previous = window.location.hash;
    vi.spyOn(window, "confirm").mockReturnValue(false);
    window.history.pushState(null, "", "/#project=atlas&mode=cards");
    fireEvent.popState(window);
    expect(window.location.hash).toBe(previous);
    expect(screen.getByLabelText("Markdown 编辑器")).toHaveValue(
      "unsaved branch notes",
    );
  });
});
