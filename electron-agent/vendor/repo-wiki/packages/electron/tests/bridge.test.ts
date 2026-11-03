import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  registerGrenRepoWiki,
  registerStandaloneIpc,
  type SenderEvent,
} from "../src/index.js";
import { createPreloadApi, exposeRepoWiki } from "../src/preload.js";
import { createGrenRepoWikiClient } from "../../renderer/src/index.js";
import { PROGRESS_EVENT } from "../../contracts/src/index.js";
const sender: SenderEvent = {
  sender: { id: 1, send() {}, isDestroyed: () => false },
  senderFrame: { url: "app://trusted/index.html" },
};
async function setup(t: any) {
  const temp = await mkdtemp(path.join(tmpdir(), "repowiki-electron-test-"));
  const approved = path.join(temp, "approved"),
    outside = path.join(temp, "outside");
  await mkdir(approved);
  await mkdir(outside);
  t.after(() => rm(temp, { recursive: true, force: true }));
  const calls: Array<{ action: string; input: any }> = [],
    handlers = new Map<string, any>(),
    broadcasts: any[] = [];
  let listener: any,
    unsubscribed = 0,
    trusted = true;
  const client = {
    invoke: async (action: string, input: any) => {
      calls.push({ action, input });
      if (action === "projects")
        return [
          { id: "allowed", path: approved },
          { id: "outside", path: outside },
        ];
      if (action === "project")
        return {
          id: input.project_id,
          path: input.project_id === "outside" ? outside : approved,
        };
      return { ok: true };
    },
    subscribe: (handler: any) => {
      listener = handler;
      return () => {
        unsubscribed++;
      };
    },
  };
  const host = {
    registerCommand: (name: string, handler: any) => {
      handlers.set(name, handler);
      return () => {
        handlers.delete(name);
      };
    },
    isTrustedSender: () => trusted,
    allowedWorkspaces: async () => [approved],
    sendEvent: (recipient: SenderEvent, event: string, payload: any) => {
      broadcasts.push({ recipient: recipient.sender.id, event, payload });
    },
  };
  return {
    approved,
    outside,
    calls,
    handlers,
    broadcasts,
    client: client as any,
    host,
    setTrusted: (value: boolean) => {
      trusted = value;
    },
    event: (value: any) => listener(value),
    get unsubscribed() {
      return unsubscribed;
    },
  };
}
test("bridge registers separate repoWiki commands, validates input, and rejects untrusted senders", async (t) => {
  const state = await setup(t);
  const dispose = registerGrenRepoWiki(state.client, state.host);
  assert.ok(state.handlers.has("repoWiki_health"));
  assert.ok(!state.handlers.has("agentData_wiki_list"));
  state.setTrusted(false);
  await assert.rejects(
    state.handlers.get("repoWiki_create")(sender, { path: state.approved }),
    /Untrusted/,
  );
  assert.equal(state.calls.length, 0);
  state.setTrusted(true);
  await assert.rejects(
    state.handlers.get("repoWiki_create")(sender, {
      path: state.approved,
      shell: "whoami",
    }),
    /Unexpected/,
  );
  await state.handlers.get("repoWiki_create")(sender, { path: state.approved });
  assert.equal(state.calls.at(-1)!.action, "create");
  dispose();
  assert.equal(state.handlers.size, 0);
  assert.equal(state.unsubscribed, 1);
});
test("host workspace roots confine project access and list output; embedded clone is disabled", async (t) => {
  const state = await setup(t);
  const dispose = registerGrenRepoWiki(state.client, state.host);
  t.after(dispose);
  await assert.rejects(
    state.handlers.get("repoWiki_create")(sender, { path: state.outside }),
    /outside/,
  );
  await assert.rejects(
    state.handlers.get("repoWiki_source")(sender, {
      project_id: "outside",
      path: "secret.ts",
    }),
    /outside/,
  );
  assert.equal(
    state.calls.filter((call) => call.action === "source").length,
    0,
  );
  const projects = await state.handlers.get("repoWiki_projects")(sender, {});
  assert.deepEqual(
    projects.map((p: any) => p.id),
    ["allowed"],
  );
  await assert.rejects(
    state.handlers.get("repoWiki_clone")(sender, {
      url: "https://github.com/a/b",
    }),
    /disabled/,
  );
});
test("workspace async authorization rechecks disposed state and navigation trust", async (t) => {
  for (const mode of ["disposed", "navigated"]) {
    const state = await setup(t);
    let release!: (roots: string[]) => void;
    state.host.allowedWorkspaces = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const dispose = registerGrenRepoWiki(state.client, state.host);
    const handler = state.handlers.get("repoWiki_create");
    const pending = handler(sender, { path: state.approved });
    if (mode === "disposed") dispose();
    else state.setTrusted(false);
    release([state.approved]);
    await assert.rejects(pending, /Untrusted|disposed|trusted/i);
    assert.equal(state.calls.length, 0);
    dispose();
  }
});
test("progress subscription is removed at bridge disposal and no later broadcast occurs", async (t) => {
  const state = await setup(t);
  const dispose = registerGrenRepoWiki(state.client, state.host);
  const event = {
    project_id: "allowed",
    time: new Date().toISOString(),
    run: { status: "running" },
  };
  state.event(event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.broadcasts.length, 0);
  await state.handlers.get("repoWiki_projects")(sender, {});
  state.event({ ...event, project_id: "outside" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.broadcasts.length, 0);
  state.event(event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.broadcasts.length, 1);
  assert.equal(state.broadcasts[0].event, PROGRESS_EVENT);
  dispose();
  state.event(event);
  assert.equal(state.broadcasts.length, 1);
});
test("standalone IPC uses one bounded channel and removes it on dispose", async (t) => {
  const state = await setup(t),
    handlers = new Map<string, any>();
  const ipc = {
    handle: (name: string, handler: any) => {
      handlers.set(name, handler);
    },
    removeHandler: (name: string) => {
      handlers.delete(name);
    },
  };
  const dispose = registerStandaloneIpc(ipc, state.client, {
    isTrustedSender: state.host.isTrustedSender,
    allowedWorkspaces: state.host.allowedWorkspaces,
    sendEvent() {},
  });
  assert.deepEqual([...handlers.keys()], ["repoWiki:invoke"]);
  await assert.rejects(
    Promise.resolve().then(() =>
      handlers.get("repoWiki:invoke")(sender, { action: "exec", input: {} }),
    ),
    /Unknown/,
  );
  await handlers.get("repoWiki:invoke")(sender, {
    action: "health",
    input: {},
  });
  dispose();
  assert.equal(handlers.size, 0);
});
test("preload exposes only frozen invoke/subscribe capability and strips Electron event object", async () => {
  const invokes: any[] = [],
    listeners = new Map<string, any>();
  let removed = 0,
    exposed: any;
  const ipc = {
    invoke: async (channel: string, message: any) => {
      invokes.push({ channel, message });
      return { ok: true };
    },
    on: (channel: string, listener: any) => {
      listeners.set(channel, listener);
    },
    removeListener: (channel: string, listener: any) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
      removed++;
    },
  };
  const api = createPreloadApi(ipc);
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(Object.keys(api).sort(), ["invoke", "subscribe"]);
  await assert.rejects(api.invoke("shell" as any, {} as any), /Unknown/);
  assert.equal(invokes.length, 0);
  await api.invoke("health", {});
  assert.deepEqual(invokes[0], {
    channel: "repoWiki:invoke",
    message: { action: "health", input: {} },
  });
  let received: any;
  const off = api.subscribe((value) => {
    received = value;
  });
  const event = { project_id: "allowed", time: "", run: { status: "ready" } };
  listeners.get(PROGRESS_EVENT)({ sender: "privileged" }, event);
  assert.deepEqual(received, event);
  assert.ok(!("sender" in received));
  off();
  assert.equal(listeners.size, 0);
  assert.equal(removed, 1);
  exposeRepoWiki(
    {
      exposeInMainWorld: (name, value) => {
        exposed = { name, value };
      },
    },
    ipc,
  );
  assert.equal(exposed.name, "repoWiki");
  assert.deepEqual(Object.keys(exposed.value).sort(), ["invoke", "subscribe"]);
});
test("Gren runtime adapter uses actual invoke and payload subscription shape; late disposal cleans up", async () => {
  let callback: any,
    resolveSubscription!: (off: () => void) => void,
    removed = 0,
    seen = 0;
  const invokes: any[] = [];
  const runtime = {
    invoke: async (command: string, args?: any) => {
      invokes.push({ command, args });
      return {} as any;
    },
    subscribe: async <T>(
      _event: string,
      handler: (event: { payload: T }) => void,
    ) => {
      callback = handler;
      return new Promise<() => void>((resolve) => {
        resolveSubscription = resolve;
      });
    },
  };
  const client = createGrenRepoWikiClient(runtime);
  await client.invoke("health", {});
  assert.deepEqual(invokes[0], { command: "repoWiki_health", args: {} });
  const off = client.subscribe(() => {
    seen++;
  });
  off();
  resolveSubscription(() => {
    removed++;
  });
  await new Promise((resolve) => setImmediate(resolve));
  callback({ payload: { project_id: "allowed", run: { status: "ready" } } });
  assert.equal(seen, 0);
  assert.equal(removed, 1);
});
test("workspace revoked after authorization receives no subsequent progress metadata", async (t) => {
  const state = await setup(t);
  const dispose = registerGrenRepoWiki(state.client, state.host);
  t.after(dispose);
  await state.handlers.get("repoWiki_projects")(sender, {});
  state.host.allowedWorkspaces = async () => [state.outside];
  await state.event({
    project_id: "allowed",
    time: "",
    run: { status: "running", message: "Private prior workspace page name" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.broadcasts.length, 0);
});

import { bindRepoWikiAppQuit } from "../../../examples/grenagent/integration.js";
test("host quit integration waits cleanup once before retrying app quit", async () => {
  let handler: ((event: { preventDefault(): void }) => void) | undefined;
  let quitting = 0,
    prevented = 0,
    cleanups = 0;
  let finish!: () => void;
  const app = {
    on: (
      _name: "before-quit",
      fn: (event: { preventDefault(): void }) => void,
    ) => {
      handler = fn;
    },
    removeListener: () => {
      handler = undefined;
    },
    quit: () => {
      quitting++;
    },
  };
  const off = bindRepoWikiAppQuit(app, () => {
    cleanups++;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const event = {
    preventDefault: () => {
      prevented++;
    },
  };
  handler!(event);
  handler!(event);
  assert.equal(cleanups, 1);
  assert.equal(quitting, 0);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quitting, 1);
  handler!(event);
  assert.equal(prevented, 2);
  off();
  assert.equal(handler, undefined);
});
