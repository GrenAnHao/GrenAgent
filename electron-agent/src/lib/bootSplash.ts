/** 与 index.html 中 #boot-splash 的 opacity 过渡时长一致。 */
const FADE_MS = 450;

/**
 * 收起冷启动加载页（index.html 的 #boot-splash）：先淡出，再移除节点。
 * 它在 #root 之外，React 挂载不会替换它，只能在首屏就绪或渲染崩溃时由应用显式收起。
 * 重复调用无副作用。
 */
export function dismissBootSplash(): void {
  const splash = document.getElementById('boot-splash');
  if (!splash || splash.classList.contains('is-leaving')) return;
  // 离场态立即关掉整屏拖拽区和指针事件，淡出期间下面的界面已经可以操作。
  splash.classList.add('is-leaving');
  setTimeout(() => splash.remove(), FADE_MS);
}
