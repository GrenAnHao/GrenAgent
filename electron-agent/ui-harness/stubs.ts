/**
 * 场景里替代主进程的桩，以及场景和 probe 之间的通道。
 *
 * 场景页面没有 preload：渲染层通过 contextBridge 拿到的全局对象（window.gren）
 * 在这里装假的。只写场景用得到的方法，数据从 fixtures.ts 来。
 *
 * 通道（probe 那边对应的读法）：
 *   track(event)          → t.events()      记交互结果，例如 'delete:row-2'
 *   exposeData({...})     → t.data()        暴露期望值，probe 里不再抄一份数字
 *   exposeActions({...})  → t.act(name)     让 probe 驱动场景，例如模拟「别的页面改了数据」
 */

/** preload 里 contextBridge.exposeInMainWorld 的名字 */
export const BRIDGE = 'gren'

type Action = (...args: never[]) => unknown
type UiWindow = Record<string, unknown> & {
  __uiEvents?: string[]
  __uiActions?: Record<string, Action>
  __uiData?: Record<string, unknown>
}

const ui = window as unknown as UiWindow
ui.__uiEvents = ui.__uiEvents ?? []

/** 装上假的 window[BRIDGE]。只写场景用到的方法；没写到的方法被调用时会报错，正好暴露漏桩 */
export function installBridge(api: Record<string, unknown>): void {
  ui[BRIDGE] = api
}

/** 记一条交互结果，probe 用 t.events() 读出来断言 */
export function track(event: string): void {
  ui.__uiEvents?.push(event)
}

/** 暴露场景数据（fixtures 造的行数、分组、期望文案），probe 用 t.data() 读 */
export function exposeData(data: Record<string, unknown>): void {
  ui.__uiData = { ...(ui.__uiData ?? {}), ...data }
}

/** 暴露给 probe 调用的场景操作，probe 里 await t.act('name', ...args) */
export function exposeActions(actions: Record<string, Action>): void {
  ui.__uiActions = { ...(ui.__uiActions ?? {}), ...actions }
}

/** 等一会儿：给桩加上网络延迟，查询中 / 加载中的状态才看得见 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 手动放行的 Promise：桩先返回 gate.promise，probe 断言完「进行中」的界面，
 * 再通过 exposeActions 里的 gate.resolve(...) 放行，时序完全可控。
 */
export function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
