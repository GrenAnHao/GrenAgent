/** Approximate tool-definition cost. Count before rounding, and reuse sizes across status polls. */
export function definitionChars(name: string, tool?: { description?: string; inputSchema?: unknown }): number {
  return JSON.stringify({name, description:tool?.description, parameters:tool?.inputSchema}).length;
}

export type ToolFootprint = readonly [chars: number, exposure: string];
