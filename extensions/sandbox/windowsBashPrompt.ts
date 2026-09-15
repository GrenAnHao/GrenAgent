const WIN_SNIPPET =
  "Execute PowerShell commands (Get-ChildItem, Select-String, Get-Content, etc.)";

const WIN_GUIDELINE =
  "On Windows this tool runs PowerShell (pwsh or 5.1), not bash. Write PowerShell: Get-ChildItem, Select-String, Get-Content; chain with `;`. Do not use POSIX ls -la, grep, find, or `&&`. Native programs (tsc, git, vitest) must end with `; exit $LASTEXITCODE` or the process exit code will be 1.";

const WIN_DESCRIPTION_SUFFIX = `

Windows: this tool runs PowerShell (pwsh if present, otherwise Windows PowerShell 5.1). The command argument must be PowerShell, not POSIX. Use Get-ChildItem, Select-String, and Get-Content. Chain with semicolons. Do not use ls -la, grep, find, or &&. When running native programs (build, test, git), end with ; exit $LASTEXITCODE or the real exit code is lost (PowerShell reports 1).`;

export function annotateWindowsBashTool<
  T extends {
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: readonly string[];
  },
>(def: T, platform: NodeJS.Platform = process.platform): T {
  if (platform !== "win32") return def;
  return {
    ...def,
    description: `${def.description ?? ""}${WIN_DESCRIPTION_SUFFIX}`,
    promptSnippet: WIN_SNIPPET,
    promptGuidelines: [...(def.promptGuidelines ?? []), WIN_GUIDELINE],
  };
}
