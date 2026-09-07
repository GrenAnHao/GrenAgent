import { app, type BrowserWindow, type WebContents } from 'electron';

/** `before-input-event` 回传的按键信息（只取用到的字段，便于单测直接构造）。 */
export interface KeyInput {
  type: 'keyDown' | 'keyUp' | string;
  key: string;
  isAutoRepeat: boolean;
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/**
 * F12 全平台通用；另加各平台惯用的「检查」组合键（Windows/Linux 的 Ctrl+Shift+I、macOS 的 Cmd+Option+I）。
 * 只认 keyDown：keyUp 也响应的话一次按键会开关各一次，表现为「按了没反应」。
 * 忽略 isAutoRepeat：按住 F12 不放会持续派发 keyDown，不去重的话 DevTools 会被来回开关。
 */
export function isDevToolsShortcut(input: KeyInput): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return false;
  if (input.key === 'F12') return true;
  if (input.key.toLowerCase() !== 'i') return false;
  if (input.control && input.shift && !input.alt && !input.meta) return true;
  if (input.meta && input.alt && !input.control && !input.shift) return true;
  return false;
}

/**
 * 开发构建默认可开；打包后用 GREN_DEVTOOLS=1 显式打开。
 * 与 dev_* 诊断命令、开发者工作台同一套口径：生产版本不默认把调试入口暴露给终端用户。
 */
export function isDevToolsShortcutEnabled(): boolean {
  return !app.isPackaged || process.env.GREN_DEVTOOLS === '1';
}

/**
 * 给窗口挂上 DevTools 快捷键。
 *
 * 走 webContents 的 before-input-event 而不是 globalShortcut：后者是系统级抢注，
 * 应用没焦点时按下也会弹出 DevTools（还会和其它抢了 F12 的程序互相打架）。
 *
 * 用 detach 模式而不是默认的贴边停靠：本应用是无边框 + 自绘标题栏，停靠会把窗口内容挤窄，
 * 触发一大片 ResizeObserver/布局重算；独立窗口对排查问题更友好，也不会污染应用自身的布局状态。
 */
export function attachDevToolsShortcut(window: BrowserWindow): void {
  if (!isDevToolsShortcutEnabled()) return;
  bindShortcut(window.webContents);
  // 焦点在 <webview>（内置浏览器等）里时，按键走的是 guest 的 webContents，不会冒泡到宿主，
  // 所以每个挂载上来的 guest 都要单独绑一次。
  window.webContents.on('did-attach-webview', (_event, guest) => bindShortcut(guest));
}

function bindShortcut(target: WebContents): void {
  target.on('before-input-event', (event, input) => {
    if (!isDevToolsShortcut(input)) return;
    event.preventDefault();
    if (target.isDevToolsOpened()) target.closeDevTools();
    else target.openDevTools({ mode: 'detach', activate: true });
  });
}
