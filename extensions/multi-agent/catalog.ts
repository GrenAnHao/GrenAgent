import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface SubagentCatalogFact {
  version: 0;
  childId: string;
  sessionPath: string;
  childCreatedAt: number;
  mode: "one-shot" | "continuable";
  label: string;
}

export interface SubagentCatalogEntry {
  id: string;
  sessionPath: string;
  createdAt: number;
  mode: "one-shot" | "continuable";
  label: string;
}

export interface CatalogDiagnostic {
  id: string;
  reason: "corrupt";
}

export interface SubagentCatalogView {
  entries: SubagentCatalogEntry[];
  diagnostics: CatalogDiagnostic[];
}

export function establishCatalogChild(
  appendEntry: (customType: string, data: SubagentCatalogFact) => void,
  fact: Omit<SubagentCatalogFact, "version">,
): void {
  appendEntry("subagent_catalog", { version: 0, ...fact });
}

export function foldCatalogFromEntries(entries: Array<Record<string, unknown>>): SubagentCatalogView {
  let start = 0;
  entries.forEach((e, i) => {
    if (e.customType === "subagent_catalog_base") start = i + 1;
  });
  const slice = entries.slice(start);
  const view: SubagentCatalogView = { entries: [], diagnostics: [] };
  for (const e of slice) {
    if (e.customType !== "subagent_catalog") continue;
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (
      d.version !== 0 ||
      typeof d.childId !== "string" ||
      typeof d.sessionPath !== "string" ||
      (d.mode !== "one-shot" && d.mode !== "continuable")
    ) {
      view.diagnostics.push({ id: typeof d.childId === "string" ? d.childId : "unknown", reason: "corrupt" });
      continue;
    }
    view.entries.push({
      id: d.childId,
      sessionPath: d.sessionPath,
      createdAt: typeof d.childCreatedAt === "number" ? d.childCreatedAt : 0,
      mode: d.mode,
      label: typeof d.label === "string" && d.label.trim() ? d.label : "(untitled)",
    });
  }
  return view;
}

export function foldCatalog(sessionPath: string): SubagentCatalogView {
  try {
    const sm = SessionManager.open(sessionPath);
    return foldCatalogFromEntries(sm.buildContextEntries() as unknown as Array<Record<string, unknown>>);
  } catch {
    return { entries: [], diagnostics: [] };
  }
}
