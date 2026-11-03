import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  ProjectCollection,
  groupCollectionProjects,
  type CollectionProject,
} from "./ProjectCollection";
import { ProjectOverview } from "./GenerationOverview";
import {
  KnowledgeCardList,
  type KnowledgeCardRecord,
} from "./KnowledgeCardList";
const page = (
  id: string,
  extras: Partial<KnowledgeCardRecord> = {},
): KnowledgeCardRecord => ({
  id,
  title: id,
  markdown: "# Document\nSource-grounded explanation.",
  status: "ready",
  revision: 1,
  sources: [],
  ...extras,
});
const project = (
  id: string,
  extras: Partial<CollectionProject> = {},
): CollectionProject => ({
  id,
  name: `Repository ${id}`,
  path: `/repos/${id}`,
  language: "zh",
  watch: false,
  page_count: 3,
  card_count: 1,
  knowledge: {
    wiki: {
      count: 3,
      updated_at: "2026-10-31T05:30:00Z",
      identity: { commit: "12345678abcdef" },
      last_run: { completed_at: "2026-10-31T05:30:00Z" },
    },
    cards: {
      count: 1,
      updated_at: "2026-10-30T11:00:00Z",
      identity: { commit: "abcdef12345678" },
    },
  },
  ...extras,
});
const collectionProps = {
  loading: false,
  onSelect: vi.fn(),
  onCreate: vi.fn(),
  onRefresh: vi.fn(),
};

describe("repository collection", () => {
  it("keeps search beside the actual filters and makes the hero illustration non-interactive", () => {
    const { container } = render(
      <ProjectCollection {...collectionProps} projects={[project("alpha")]} />,
    );
    const controls = screen.getByRole("group", { name: "项目筛选与视图" });
    expect(
      within(controls).getByRole("textbox", { name: "搜索 Repo Wiki 项目" }),
    ).toBeInTheDocument();
    expect(
      within(controls).getByRole("group", { name: "项目生成状态筛选" }),
    ).toBeInTheDocument();
    expect(
      within(controls).getByRole("group", { name: "项目显示方式" }),
    ).toBeInTheDocument();
    expect(container.querySelector("header input")).toBeNull();
    const illustration = container.querySelector(".rw-collection-art");
    expect(illustration).toHaveAttribute("aria-hidden", "true");
    expect(illustration?.querySelector("button,a,input,[tabindex]")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^打开项目/ })).toHaveLength(
      1,
    );
  });
  it("renders real per-kind counts, filters generation state and searches actual names/paths", () => {
    const generated = project("alpha"),
      empty = project("beta", {
        page_count: 0,
        card_count: 0,
        knowledge: { wiki: { count: 0 }, cards: { count: 0 } },
      });
    render(
      <ProjectCollection {...collectionProps} projects={[generated, empty]} />,
    );
    const alpha = screen.getByRole("button", {
      name: "打开项目 Repository alpha",
    });
    expect(within(alpha).getByLabelText("Wiki 文档 3")).toBeInTheDocument();
    expect(within(alpha).getByLabelText("知识卡片 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "未生成" }));
    expect(
      screen.queryByRole("button", { name: "打开项目 Repository alpha" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "打开项目 Repository beta" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "搜索 Repo Wiki 项目" }),
      { target: { value: "/repos/alpha" } },
    );
    expect(
      screen.queryByRole("button", { name: "打开项目 Repository beta" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "打开项目 Repository alpha" }),
    );
    expect(collectionProps.onSelect).toHaveBeenCalledWith("alpha");
  });
  it("shows one language variant per canonical repository without adding counts together", () => {
    const zh = project("zh", {
      path: "/repos/shared",
      page_count: 2,
      card_count: 0,
      knowledge: { wiki: { count: 2 }, cards: { count: 0 } },
    });
    const en = project("en", {
      path: "/repos/shared/",
      language: "en",
      page_count: 20,
      card_count: 9,
      knowledge: { wiki: { count: 20 }, cards: { count: 9 } },
      updated_at: "2027-01-01T00:00:00Z",
    });
    render(<ProjectCollection {...collectionProps} projects={[en, zh]} />);
    expect(screen.getAllByRole("button", { name: /^打开项目/ })).toHaveLength(
      1,
    );
    expect(
      screen.getByRole("button", { name: "打开项目 Repository zh" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Wiki 文档 2")).toBeInTheDocument();
    expect(screen.queryByLabelText("Wiki 文档 22")).toBeNull();
  });
  it("chooses the newer actual variant when no Chinese variant exists", () => {
    const old = project("old", {
      path: "/repos/same",
      language: "en",
      knowledge: {},
      updated_at: "2024-01-01T00:00:00Z",
      last_run: undefined,
    });
    const newer = project("new", {
      path: "/repos/same",
      language: "de",
      knowledge: {},
      updated_at: "2025-01-01T00:00:00Z",
      last_run: undefined,
    });
    expect(groupCollectionProjects([old, newer])[0].id).toBe("new");
  });
  it("does not substitute a later project-setting edit for the document generation date", () => {
    render(
      <ProjectCollection
        {...collectionProps}
        projects={[project("date", { updated_at: "2027-01-01T00:00:00Z" })]}
      />,
    );
    expect(screen.getByText(/更新于 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/更新于 2027/)).toBeNull();
  });
  it("does not merge distinct POSIX paths containing literal backslashes", () => {
    expect(
      groupCollectionProjects([
        project("literal", { path: "/repos/a\\b" }),
        project("nested", { path: "/repos/a/b" }),
      ]),
    ).toHaveLength(2);
  });
  it("switches grid/list and delegates connect/refresh without submitting a host form", () => {
    const submit = vi.fn((event) => event.preventDefault()),
      onCreate = vi.fn(),
      onRefresh = vi.fn();
    const { container } = render(
      <form onSubmit={submit}>
        <ProjectCollection
          {...collectionProps}
          onCreate={onCreate}
          onRefresh={onRefresh}
          projects={[project("x")]}
        />
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "列表视图" }));
    expect(container.querySelector(".rw-projects-list")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "连接仓库" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "刷新项目" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    for (const button of container.querySelectorAll("button"))
      expect(button).toHaveAttribute("type", "button");
  });
  it("does not invent counts for incomplete records and shows explicit empty/loading states", () => {
    const { rerender } = render(
      <ProjectCollection
        {...collectionProps}
        projects={[
          project("unknown", {
            page_count: undefined,
            card_count: undefined,
            knowledge: undefined,
          }),
        ]}
      />,
    );
    expect(screen.getByLabelText("Wiki 文档 数量未知")).toHaveTextContent("—");
    expect(screen.getByLabelText("知识卡片 数量未知")).toHaveTextContent("—");
    expect(screen.getByText("待同步")).toBeInTheDocument();
    rerender(<ProjectCollection {...collectionProps} loading projects={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取");
    expect(screen.getByRole("button", { name: "刷新项目" })).toBeDisabled();
    rerender(<ProjectCollection {...collectionProps} projects={[]} />);
    expect(screen.getByText("还没有连接仓库")).toBeInTheDocument();
  });
});

describe("independent generation overview", () => {
  const callbacks = {
    onLanguage: vi.fn(),
    onGenerate: vi.fn(),
    onCancel: vi.fn(),
  };
  it("shows Wiki snapshot counts/commit, actual language, offline label and working actions", () => {
    const selected = project("sample", {
      plan: { pages: [{ id: "one" }, { id: "two" }, { id: "three" }] },
    });
    render(
      <ProjectOverview
        project={selected}
        mode="wiki"
        run={null}
        busy={false}
        provider="demo"
        {...callbacks}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Repo Wiki 概览" }),
    ).toBeInTheDocument();
    expect(screen.getByText("3 / 3 已保存，0 失败")).toBeInTheDocument();
    expect(screen.getByText("12345678")).toHaveAttribute(
      "title",
      "12345678abcdef",
    );
    expect(screen.getByRole("button", { name: "简体中文" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(callbacks.onLanguage).toHaveBeenCalledWith("en");
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    expect(callbacks.onGenerate).toHaveBeenCalled();
    expect(screen.getByText("离线演示 · 不调用大模型")).toBeInTheDocument();
  });
  it("uses the card snapshot rather than Wiki counts, plans, timestamps or commits", () => {
    render(
      <ProjectOverview
        project={project("sample", {
          plan: { pages: Array.from({ length: 50 }, () => ({ id: "wiki" })) },
        })}
        mode="cards"
        run={null}
        busy={false}
        provider="real"
        {...callbacks}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "知识卡片概览" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 张")).toBeInTheDocument();
    expect(screen.getByText("abcdef12")).toHaveAttribute(
      "title",
      "abcdef12345678",
    );
    expect(screen.queryByText("12345678")).toBeNull();
    expect(screen.getByText(/真实模型.*可能产生费用/)).toBeInTheDocument();
    expect(screen.queryByText(/0 失败/)).toBeNull();
  });
  it("cancels only a running target, disables language switching and uses actual progress", () => {
    render(
      <ProjectOverview
        project={project("run")}
        mode="cards"
        run={{
          status: "running",
          progress: 37,
          cancelable: true,
          message: "正在校验实际引用",
          provider: "demo",
        }}
        busy
        provider="real"
        {...callbacks}
      />,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "37");
    expect(screen.getByRole("button", { name: "English" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "取消生成" }));
    expect(callbacks.onCancel).toHaveBeenCalled();
    expect(screen.getByText("离线演示 · 不调用大模型")).toBeInTheDocument();
  });
  it("does not claim zero failures after a failed run, or display an unrelated target run", () => {
    const { rerender } = render(
      <ProjectOverview
        project={project("fail")}
        mode="cards"
        run={{ status: "failed", error: "Citation validation failed" }}
        busy={false}
        provider="demo"
        {...callbacks}
      />,
    );
    expect(screen.getByText("本次生成失败")).toBeInTheDocument();
    expect(screen.getByText("Citation validation failed")).toBeInTheDocument();
    expect(screen.queryByText(/0 失败/)).toBeNull();
    rerender(
      <ProjectOverview
        project={project("other")}
        mode="cards"
        run={{ status: "running", target: "wiki", progress: 20 } as any}
        busy
        provider="demo"
        {...callbacks}
      />,
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("button", { name: "取消生成" })).toBeNull();
    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
  });
  it("retains caller-supplied menu action and disables duplicate cancellation while requested", () => {
    const menuAction = vi.fn();
    render(
      <ProjectOverview
        project={project("cancel")}
        mode="wiki"
        run={{ status: "cancel_requested" }}
        busy
        provider="demo"
        {...callbacks}
        menu={
          <button type="button" aria-label="更多生成操作" onClick={menuAction}>
            …
          </button>
        }
      />,
    );
    expect(screen.getByRole("button", { name: "正在取消…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "更多生成操作" }));
    expect(menuAction).toHaveBeenCalledTimes(1);
  });
});

describe("knowledge card sidebar", () => {
  const cards = [
    page("cards/config", {
      title: "运行时配置",
      summary: "配置变更由文件监听触发。",
      category: "配置系统",
    }),
    page("cards/build", {
      title: "构建流程",
      summary: "模块经 TypeScript 编译后打包。",
      category: "构建系统",
      status: "edited",
    }),
    page("cards/old", { title: "已归档", status: "archived" }),
  ];
  it("renders real summaries/categories and excludes archived records from overview count", () => {
    render(
      <KnowledgeCardList
        cards={cards}
        selectedId=""
        query=""
        onSelect={() => {}}
        onOverview={() => {}}
        overviewSelected
      />,
    );
    expect(
      screen.getByRole("button", { name: /知识卡片概览/ }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByLabelText("2 张知识卡片")).toHaveTextContent("2");
    expect(screen.getByText("配置变更由文件监听触发。")).toBeInTheDocument();
    expect(screen.getByText("配置系统")).toBeInTheDocument();
    expect(screen.queryByText("已归档")).toBeNull();
  });
  it("filters summaries/categories and opens exact card IDs, with a separate overview action", () => {
    const onSelect = vi.fn(),
      onOverview = vi.fn();
    const { rerender } = render(
      <KnowledgeCardList
        cards={cards}
        selectedId="cards/build"
        query="TypeScript"
        onSelect={onSelect}
        onOverview={onOverview}
      />,
    );
    expect(screen.queryByText("运行时配置")).toBeNull();
    const build = screen.getByRole("button", { name: /构建流程/ });
    expect(build).toHaveAttribute("aria-current", "page");
    fireEvent.click(build);
    expect(onSelect).toHaveBeenCalledWith("cards/build");
    fireEvent.click(screen.getByRole("button", { name: /知识卡片概览/ }));
    expect(onOverview).toHaveBeenCalledTimes(1);
    rerender(
      <KnowledgeCardList
        cards={cards}
        selectedId=""
        query="missing"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("没有匹配");
  });
  it("renders untrusted card values as inert text and never submits a containing host form", () => {
    const submit = vi.fn((event) => event.preventDefault()),
      onSelect = vi.fn();
    const { container } = render(
      <form onSubmit={submit}>
        <KnowledgeCardList
          cards={[
            page("cards/test", {
              title: "<script>evil</script>",
              summary: "<img src=x onerror=evil()>",
              category: "<b>data</b>",
            }),
          ]}
          selectedId=""
          query=""
          onSelect={onSelect}
        />
      </form>,
    );
    expect(container.querySelector("script,img,b")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("cards/test");
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("live generation state on the collection", () => {
  it("shows a running task on its host card instead of the saved state, matching Windows paths loosely", () => {
    const hosts = [
      { key: "a", path: "D:\\Repos\\Alpha", name: "Alpha" },
      { key: "b", path: "D:\\Repos\\Beta", name: "Beta" },
    ];
    render(
      <ProjectCollection
        projects={[]}
        hostManaged
        hostProjects={hosts}
        loading={false}
        onSelect={() => {}}
        onCreate={() => {}}
        onRefresh={() => {}}
        activity={{ "d:/repos/alpha": { label: "生成中 40%", detail: "生成文档中", tone: "running", progress: 40, updatedAt: 1 } }}
      />,
    );
    const alpha = screen.getByRole("button", { name: "打开项目 Alpha" });
    expect(within(alpha).getByTestId("project-live-state")).toHaveTextContent("生成中 40%");
    expect(alpha).toHaveTextContent("生成文档中");
    expect(alpha.querySelector(".rw-project-progress > span")).toHaveStyle({ width: "40%" });
    const beta = screen.getByRole("button", { name: "打开项目 Beta" });
    expect(within(beta).queryByTestId("project-live-state")).toBeNull();
    expect(beta).toHaveTextContent("待同步");
  });
});
