import { registerToolName } from "./naming.js";
import type { McpToolDef } from "./manager.js";

export interface CatalogTool {
  fullName: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export async function allToolPages<T>(list: (cursor?: string) => Promise<{ tools: T[]; nextCursor?: string }>): Promise<{ tools: T[] }> {
  const tools: T[] = [], visited = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await list(cursor);
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor && visited.has(cursor)) throw new Error("服务器返回了重复的工具分页游标");
    if (cursor) visited.add(cursor);
  } while (cursor);
  return { tools };
}

export function catalogTools(server: string, tools: McpToolDef[], taken = new Set<string>()): CatalogTool[] {
  return tools.map(({ name, description, inputSchema }) => {
    const fullName = registerToolName(server, name, taken).name;
    taken.add(fullName);
    return { fullName, name, ...(description !== undefined && { description }), ...(inputSchema !== undefined && { inputSchema }) };
  });
}
