/** Compile-checked integration sketch for GrenAgent 310e572; NOT applied to that repository. */
import { RepoWikiProcessClient } from "../../packages/process/src/client.js";
import {
  registerGrenRepoWiki,
  type GrenRegistration,
} from "../../packages/electron/src/index.js";
import {
  createGrenRepoWikiClient,
  type GrenRuntimeBridge,
} from "../../packages/renderer/src/index.js";
interface ModelRuntimeHostPort {
  completeSimple(input: {
    user: string;
    systemPrompt?: string;
    signal?: AbortSignal;
    maxTokens?: number;
  }): Promise<string>;
}
export async function mountRepoWikiMain(options: {
  entry: string;
  userDataRoot: string;
  workspaceRoots: string[];
  model: ModelRuntimeHostPort;
  modelCacheKey: string;
  commands: GrenRegistration;
}) {
  const client = new RepoWikiProcessClient({
    entry: options.entry,
    dataDir: options.userDataRoot,
    allowedRoots: options.workspaceRoots,
    modelCacheKey: options.modelCacheKey,
    complete: (input, signal) =>
      options.model.completeSimple({ ...input, signal }),
  });
  await client.start();
  const unregister = registerGrenRepoWiki(client, options.commands);
  return {
    client,
    dispose: async () => {
      unregister();
      await client.stop();
    },
  };
}
/** Pass resulting client to <RepoWikiPanel client={client}/> in the existing GrenAgent renderer. */
export const repoWikiRenderer = (runtime: GrenRuntimeBridge) =>
  createGrenRepoWikiClient(runtime);

/** Bind once in the host main bootstrap. Prevent quit until child cleanup finishes. */
export function bindRepoWikiAppQuit(
  app: {
    on(
      event: "before-quit",
      handler: (event: { preventDefault(): void }) => void,
    ): void;
    removeListener(
      event: "before-quit",
      handler: (event: { preventDefault(): void }) => void,
    ): void;
    quit(): void;
  },
  dispose: () => Promise<void>,
) {
  let stopping = false,
    finished = false;
  const beforeQuit = (event: { preventDefault(): void }) => {
    if (finished) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    void dispose().finally(() => {
      finished = true;
      app.quit();
    });
  };
  app.on("before-quit", beforeQuit);
  return () => app.removeListener("before-quit", beforeQuit);
}
