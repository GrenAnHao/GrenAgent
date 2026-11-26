import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LedgerSession } from "./ledger.js";

type MetadataReader = Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile" | "getHeader" | "getCwd" | "getSessionName">;

export function usageSessionMetadata(manager: MetadataReader, cwd?: string): LedgerSession {
  const header = manager.getHeader();
  return {
    id: manager.getSessionId(), path: manager.getSessionFile() ?? null,
    cwd: header?.cwd ?? cwd ?? manager.getCwd() ?? null, startedAt: header?.timestamp ?? null,
    name: manager.getSessionName()?.trim() || null,
  };
}
