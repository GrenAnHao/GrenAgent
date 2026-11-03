/** Main-process bridge ONLY. Engine/SQLite/scanner must never be imported here. */
import { realpathSync } from "node:fs";
import path from "node:path";
import {
  ACTIONS,
  PROGRESS_EVENT,
  validateRequest,
  ContractError,
  type Action,
  type ProgressEvent,
} from "../../contracts/src/index.js";
import type { RepoWikiProcessClient } from "../../process/src/client.js";
export type SenderEvent = {
  sender: {
    id: number;
    send: (channel: string, payload: unknown) => void;
    isDestroyed?: () => boolean;
  };
  senderFrame?: { url: string };
};
export interface GrenRegistration {
  registerCommand(
    command: string,
    handler: (
      event: SenderEvent,
      args: Record<string, unknown>,
    ) => Promise<unknown>,
  ): void | (() => void);
  /** Verify trusted CURRENT top-level sender URL and window ownership, not renderer args. */
  isTrustedSender(event: SenderEvent): boolean;
  allowedWorkspaces(event: SenderEvent): Promise<string[]>;
  /** Optional host hook. Called only for individually authorized recipients, never broadcast. */
  sendEvent?(
    recipient: SenderEvent,
    event: string,
    payload: ProgressEvent,
  ): void;
}
function within(root: string, target: string) {
  const rel = path.relative(root, target);
  return (
    !rel ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  );
}
/** NEW repoWiki_* commands; never collide with agentData_wiki_* knowledge pages. */
export function registerGrenRepoWiki(
  client: RepoWikiProcessClient,
  host: GrenRegistration,
): () => void {
  let disposed = false;
  const removers: Array<() => void> = [];
  const recipients = new Map<
    number,
    { event: SenderEvent; projects: Map<string, string> }
  >();
  const trusted = (event: SenderEvent) => {
    if (
      disposed ||
      event.sender.isDestroyed?.() ||
      !host.isTrustedSender(event)
    )
      throw new ContractError("Untrusted or disposed RepoWiki bridge", 403);
  };
  const authorize = async (event: SenderEvent, action: Action, input: any) => {
    trusted(event);
    validateRequest(action, input);
    const roots = (await host.allowedWorkspaces(event)).map((root) =>
      realpathSync(root),
    );
    trusted(event);
    const check = (target: string) => {
      let resolved: string;
      try {
        resolved = realpathSync(target);
      } catch {
        throw new ContractError("Workspace is unavailable", 404);
      }
      if (!roots.some((root) => within(root, resolved)))
        throw new ContractError(
          "Repository is outside the approved host workspace",
          403,
        );
    };
    if (action === "create") check(input.path);
    if (action === "clone")
      throw new ContractError(
        "Clone is disabled in embedded mode. Select a host-approved repository instead.",
        403,
      );
    let projectPath: string | undefined;
    if (input.project_id) {
      const project = await client.invoke("project", {
        project_id: input.project_id,
      });
      trusted(event);
      check(project.path);
      projectPath = project.path;
    }
    trusted(event);
    const result = await client.invoke(action, input as any);
    trusted(event);
    const record = recipients.get(event.sender.id) ?? {
      event,
      projects: new Map<string, string>(),
    };
    record.event = event;
    if (input.project_id && projectPath)
      record.projects.set(input.project_id, projectPath);
    if (action === "create")
      record.projects.set((result as any).id, (result as any).path);
    if (action === "projects") {
      const allowed = (result as any[]).filter((project) => {
        try {
          check(project.path);
          return true;
        } catch {
          return false;
        }
      });
      record.projects = new Map(
        allowed.map((project) => [project.id, project.path]),
      );
      recipients.set(event.sender.id, record);
      return allowed;
    }
    recipients.set(event.sender.id, record);
    return result;
  };
  for (const action of ACTIONS) {
    const remove = host.registerCommand(`repoWiki_${action}`, (event, input) =>
      authorize(event, action, input),
    );
    if (typeof remove === "function") removers.push(remove);
  }
  const off = client.subscribe((event) => {
    for (const [id, record] of recipients) {
      const projectPath = record.projects.get(event.project_id);
      if (!projectPath) continue;
      void host
        .allowedWorkspaces(record.event)
        .then((roots) => {
          trusted(record.event);
          let actual: string;
          try {
            actual = realpathSync(projectPath);
          } catch {
            return;
          }
          if (
            !roots.some((root) => {
              try {
                return within(realpathSync(root), actual);
              } catch {
                return false;
              }
            })
          ) {
            record.projects.delete(event.project_id);
            return;
          }
          if (host.sendEvent)
            host.sendEvent(record.event, PROGRESS_EVENT, event);
          else record.event.sender.send(`gren:event:${PROGRESS_EVENT}`, event);
        })
        .catch(() => {
          recipients.delete(id);
        });
    }
  });
  return () => {
    disposed = true;
    recipients.clear();
    off();
    for (const remove of removers) remove();
  };
}
export interface IpcMainLike {
  handle(
    channel: string,
    handler: (event: SenderEvent, message: any) => Promise<unknown>,
  ): void;
  removeHandler(channel: string): void;
}
export function registerStandaloneIpc(
  ipcMain: IpcMainLike,
  client: RepoWikiProcessClient,
  host: Omit<GrenRegistration, "registerCommand">,
) {
  let disposed = false;
  const handlers = new Map<
    string,
    (event: SenderEvent, input: Record<string, unknown>) => Promise<unknown>
  >();
  const dispose = registerGrenRepoWiki(client, {
    ...host,
    registerCommand: (name, handler) => {
      handlers.set(name, handler);
      return () => {
        handlers.delete(name);
      };
    },
    sendEvent: (recipient, _name, event) =>
      recipient.sender.send(PROGRESS_EVENT, event),
  });
  ipcMain.handle("repoWiki:invoke", (event, message) => {
    if (disposed || !message || typeof message.action !== "string")
      throw new ContractError("Invalid IPC request");
    const handler = handlers.get("repoWiki_" + message.action);
    if (!handler) throw new ContractError("Unknown RepoWiki action");
    return handler(event, message.input);
  });
  return () => {
    disposed = true;
    ipcMain.removeHandler("repoWiki:invoke");
    dispose();
  };
}
