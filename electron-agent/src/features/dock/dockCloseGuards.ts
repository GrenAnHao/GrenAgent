/** 关闭前要先问一声的标签（例如文件浏览器里有未保存的修改）。返回 false 表示这次不关。 */
type CloseGuard = () => Promise<boolean>;

const guards = new Map<string, CloseGuard>();

/** 给标签挂一个关闭守卫，返回卸载函数。同一标签后挂的覆盖先挂的。 */
export function setDockCloseGuard(tabId: string, guard: CloseGuard): () => void {
  guards.set(tabId, guard);
  return () => {
    if (guards.get(tabId) === guard) guards.delete(tabId);
  };
}

/** 用户点关闭时调用：没有守卫直接放行。 */
export async function canCloseDockTab(tabId: string): Promise<boolean> {
  const guard = guards.get(tabId);
  return guard ? guard() : true;
}
