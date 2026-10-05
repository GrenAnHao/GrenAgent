const WIN_SNIPPET =
  "Execute PowerShell for programs. List and search files with ls, find, grep, or search, not bash.";

const WIN_GUIDELINE =
  "List directories with ls, match paths with find, search file contents with grep or search (ripgrep), and open files with read. Do not call bash for Get-ChildItem, Select-String, or Get-Content. On Windows bash runs PowerShell (pwsh or 5.1): chain with `;`, and do not pass POSIX ls -la, grep, find, or `&&` to bash. Native programs (tsc, git, vitest) must end with `; exit $LASTEXITCODE` or the process exit code will be 1.";

const WIN_DESCRIPTION_SUFFIX = `

Windows: this tool runs PowerShell (pwsh if present, otherwise Windows PowerShell 5.1). List directories with ls, match paths with find, search contents with grep or search (ripgrep), and open files with read. Do not use Get-ChildItem, Select-String, or Get-Content for those. The command argument must be PowerShell, not POSIX. Chain with semicolons. Do not pass ls -la, grep, find, or && to bash. When running native programs (build, test, git), end with ; exit $LASTEXITCODE or the real exit code is lost (PowerShell reports 1).`;

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
