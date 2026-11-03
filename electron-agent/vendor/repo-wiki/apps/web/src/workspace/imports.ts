/** Preserve exported relative paths; directory picker adds one outer folder. */
export async function markdownFiles(
  files: FileList | File[],
): Promise<Record<string, string>> {
  const inputs = Array.from(files);
  if (!inputs.length)
    throw new Error("请选择 Markdown 文件或已解压的 Wiki 目录");
  if (inputs.length > 100) throw new Error("每次最多导入 100 个文件");
  if (inputs.reduce((sum, file) => sum + file.size, 0) > 10_000_000)
    throw new Error("导入文件总大小不能超过 10 MB");
  const entries: Record<string, string> = {};
  for (const file of inputs) {
    let path = file.webkitRelativePath || file.name;
    if (file.webkitRelativePath) path = path.split("/").slice(1).join("/");
    if (
      path.includes("\\") ||
      path.startsWith("/") ||
      path.split("/").some((part) => !part || part === ".." || part === ".") ||
      path.includes("\0")
    )
      throw new Error("文件路径不安全");
    if (path !== ".repowiki-manifest.json" && !path.endsWith(".md"))
      throw new Error("目录仅应包含 Markdown 页面与 .repowiki-manifest.json");
    if (path in entries)
      throw new Error(`文件名重复：${path}。请使用目录导入以保留层级。`);
    entries[path] = await file.text();
  }
  return entries;
}
