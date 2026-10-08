/** 命令页签和规则页签共用：把 catch 到的任意值变成给用户看的文案。 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
