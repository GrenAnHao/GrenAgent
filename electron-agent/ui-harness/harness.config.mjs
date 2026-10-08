/**
 * ui-harness 配置。check.mjs / run.mjs / probe.mjs / vite.config.mjs 都从这里读。
 * 只放纯数据，不 import 任何东西：场景页面（浏览器端）不引用这个文件。
 */
export default {
  /** 构建产物和截图的目录前缀（都在系统临时目录下，不进仓库） */
  id: 'grenagent',

  /** 路径别名，和 electron.vite.config.ts 的 renderer 段一致；值相对 ui-harness/ */
  alias: {
    '@extensions': '../../extensions'
  },

  /** 和 electron.vite.config.ts 的 renderer.resolve.dedupe 一致 */
  dedupe: ['@pierre/diffs'],

  /**
   * 渲染层源码目录（相对 ui-harness/）。check.mjs --changed 靠它判断「改动的文件有没有场景覆盖」。
   * 别写 @extensions 指向的 ../../extensions：那是 pi 扩展（主进程侧），改了不归场景管。
   */
  sourceRoots: ['../src'],

  /** 读 .env 的目录，相对 ui-harness/。VITE_* 变量（许可证 key 之类）和正式构建一致 */
  envDir: '..',

  /** 测试视口尺寸（CSS 像素，即页面里的 innerWidth / innerHeight） */
  window: { width: 1420, height: 880 },

  /**
   * 静默模式（离屏渲染）的帧率，rAF 和 CSS 动画按这个频率跑（最高 240）。
   * null = 跟主显示器刷新率一致，动画采样和 fps 才和 --show 显示窗口时可比
   */
  frameRate: null,

  /** 额外的 webPreferences，和正式窗口保持一致（例如用了 <webview> 就写 { webviewTag: true }） */
  webPreferences: {},

  /** 单个场景的总超时（毫秒） */
  timeoutMs: 120_000,

  /** 等页面就绪（window.__uiReady）的超时（毫秒） */
  readyTimeoutMs: 15_000,

  /**
   * 组件库「关掉但还留在 DOM 里」的弹层标记，countVisible 会排除落在它里面的元素。
   */
  hiddenSelector: '.ant-popover-hidden, .ant-dropdown-hidden, .ant-tooltip-hidden',

  /** 页面未捕获错误里可以忽略的（正则），例如第三方库的许可证提示 */
  ignoredPageErrors: [/ResizeObserver loop/]
}
