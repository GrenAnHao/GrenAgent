import { it, expect, vi } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";
import { RepoWikiPanel } from "../RepoWikiPanel";
const project = {
  id: "embedded",
  name: "Embedded",
  path: "/safe/repo",
  language: "zh",
  watch: false,
  pages: [],
  cards: [],
  page_count: 0,
  card_count: 0,
  knowledge: { wiki: { count: 0 }, cards: { count: 0 } },
};
function makeClient() {
  const unsubscribe = vi.fn();
  const client = {
    invoke: vi.fn(async (action: string) => {
      if (action === "health") return { status: "ok", provider: {} };
      if (action === "projects") return [project];
      if (action === "changes") return { changed: [], added: [], deleted: [] };
      if (action === "run") return { status: "idle" };
      return project;
    }),
    subscribe: vi.fn(() => unsubscribe),
  } as any;
  return { client, unsubscribe };
}
it("embedded collection/project navigation uses injected IPC and never changes host hash", async () => {
  window.history.replaceState(null, "", "/#host-chat-route");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const { client, unsubscribe } = makeClient();
  const view = render(<RepoWikiPanel client={client} />);
  await screen.findByRole("button", { name: "打开项目 Embedded" });
  expect(
    screen.queryByRole("complementary", { name: "Wiki 导航" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "打开项目 Embedded" }));
  await screen.findByRole("heading", { name: "Repo Wiki 概览" });
  fireEvent.click(
    screen.getByRole("button", { name: "知识卡片", exact: true } as any),
  );
  await screen.findByRole("heading", { name: "知识卡片概览" });
  fireEvent.click(
    screen.getByRole("button", { name: "返回 Repo Wiki 项目集合" }),
  );
  expect(window.location.hash).toBe("#host-chat-route");
  expect(fetch).not.toHaveBeenCalled();
  expect(
    view.container
      .querySelector(".repo-wiki-root")
      ?.getAttribute("data-embedded"),
  ).toBe("true");
  await waitFor(() => expect(client.subscribe).toHaveBeenCalled());
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
it("collection and project controls never submit an enclosing host form", async () => {
  const submit = vi.fn((event) => event.preventDefault());
  const { client } = makeClient();
  render(
    <form onSubmit={submit}>
      <RepoWikiPanel client={client} />
    </form>,
  );
  const tile = await screen.findByRole("button", { name: "打开项目 Embedded" });
  expect(tile).toHaveAttribute("type", "button");
  fireEvent.click(tile);
  await screen.findByRole("heading", { name: "Repo Wiki 概览" });
  fireEvent.click(
    screen.getByRole("button", { name: "知识卡片", exact: true } as any),
  );
  await screen.findByRole("heading", { name: "知识卡片概览" });
  expect(submit).not.toHaveBeenCalled();
});

it("keeps a Wiki progress event separate from the selected cards namespace", async () => {
  let emit!: (event: any) => void;
  const { client } = makeClient();
  client.subscribe.mockImplementation((callback: any) => {
    emit = callback;
    return () => {};
  });
  client.invoke.mockImplementation(async (action: string) => {
    if (action === "health") return { status: "ok" };
    if (action === "projects") return [project];
    if (action === "changes") return {};
    if (action === "run") return { status: "idle" };
    return {
      ...project,
      runs_by_kind: { wiki: { status: "idle" }, cards: { status: "idle" } },
    };
  });
  render(<RepoWikiPanel client={client} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "打开项目 Embedded" }),
  );
  await screen.findByRole("heading", { name: "Repo Wiki 概览" });
  fireEvent.click(
    screen.getByRole("button", { name: "知识卡片", exact: true } as any),
  );
  await screen.findByRole("heading", { name: "知识卡片概览" });
  act(() =>
    emit({
      project_id: "embedded",
      run: {
        id: "wiki-run",
        status: "running",
        target: "wiki",
        message: "Wiki analysis",
        progress: 20,
      },
    }),
  );
  expect(screen.getByText("Wiki · Wiki analysis")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "生成卡片" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "取消生成" }),
  ).not.toBeInTheDocument();
  act(() =>
    emit({
      project_id: "embedded",
      run: { id: "wiki-run", status: "completed", target: "wiki" },
    }),
  );
  expect(screen.getByRole("button", { name: "生成卡片" })).not.toBeDisabled();
  expect(
    screen.getByRole("region", { name: "知识卡片概览" }),
  ).toHaveTextContent("未生成");
});
