/** Short calls stay in the main process, which owns auth.json and OAuth refresh. */
export interface AgentDataModelPort {
  describe(): Promise<string>;
  complete(input: {
    user: string;
    systemPrompt?: string;
    maxTokens?: number;
    expectedModel?: string;
    expectedConfiguration?: string;
    signal?: AbortSignal;
    onUsage?: (report: { model: string; usage: unknown }) => void;
  }): Promise<string>;
}
