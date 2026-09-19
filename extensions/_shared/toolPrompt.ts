/** Official Pi fields so a custom tool appears under Available tools. */
export function toolPrompt(snippet: string, guidelines?: readonly string[]) {
  return {
    promptSnippet: snippet,
    ...(guidelines && guidelines.length > 0 ? { promptGuidelines: [...guidelines] } : {}),
  };
}
