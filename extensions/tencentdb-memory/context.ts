export interface MemoryRecallClient {
  searchAtomic(params: { query: string; limit: number }): Promise<{
    items: Array<{ id: string; type: string; content: string; score: number }>;
  }>;
  readCore(): Promise<{ content: string | null; created_at: string | null; updated_at: string | null }>;
  listScenarios(): Promise<{
    entries: Array<{ path: string; summary?: string; created_at: string; updated_at: string }>;
    total: number;
  }>;
}

export interface RecallInjection {
  systemPrompt?: string;
  message?: {
    customType: "tencentdb-memory";
    content: string;
    display: false;
  };
}

const MAX_PERSONA_CHARS = 6_000;
const MAX_CONTEXT_CHARS = 8_000;

export async function buildRecallInjection(client: MemoryRecallClient, query: string): Promise<RecallInjection> {
  const [atomic, core, scenarios] = await Promise.all([
    client.searchAtomic({ query, limit: 5 }),
    client.readCore(),
    client.listScenarios(),
  ]);

  const persona = core.content?.trim().slice(0, MAX_PERSONA_CHARS) ?? "";
  const memoryLines = atomic.items
    .map((item) => `- [${item.type}] ${item.content.trim()}`)
    .filter((line) => line.length > 0);
  const scenarioLines = scenarios.entries
    .filter((entry) => entry.summary?.trim())
    .map((entry) => `- ${entry.path}: ${entry.summary!.trim()}`);

  const contextSections: string[] = [];
  if (memoryLines.length > 0) contextSections.push(`## Relevant atomic memory\n${memoryLines.join("\n")}`);
  if (scenarioLines.length > 0) contextSections.push(`## Relevant scenarios\n${scenarioLines.join("\n")}`);

  const result: RecallInjection = {};
  if (persona) {
    result.systemPrompt = `<user-persona>\n${persona}\n</user-persona>`;
  }
  if (contextSections.length > 0) {
    result.message = {
      customType: "tencentdb-memory",
      content: contextSections.join("\n\n").slice(0, MAX_CONTEXT_CHARS),
      display: false,
    };
  }
  return result;
}
