// 仅业务代码读取的 Date.now() 可推进。不要替换 Date 构造器、定时器或帧时钟。
const wallClockScenarios = new Set(['attention-toast'])

/** 在动态加载场景前调用；未选中的窗口不安装任何东西。 */
export function installScenarioClock(scenario, page = window) {
  if (!wallClockScenarios.has(scenario)) return
  const date = page.Date
  const nativeNow = date.now
  let now = nativeNow()
  date.now = () => now
  page.__uiClock = {
    advanceBy(ms) {
      if (!Number.isFinite(ms) || ms < 0 || !Number.isFinite(now + ms)) {
        return false
      }
      now += ms
      return now
    }
  }
  return () => {
    date.now = nativeNow
    delete page.__uiClock
  }
}

/** probe 在 Electron 主进程中；只把数值送进本次场景的窗口，不修改主进程时间。 */
export function createProbeClock(js) {
  return {
    async advanceBy(ms) {
      const value = Number.isFinite(ms) ? ms : null
      // executeJavaScript 会丢掉渲染层异常的原文。传回结果，保留可读的 probe 报错。
      const next = await js(`window.__uiClock?.advanceBy(${value}) ?? null`)
      if (next === null) throw new Error('当前场景未启用业务时钟')
      if (next === false) throw new RangeError('clock.advanceBy 需要有限且非负的毫秒数')
      return next
    }
  }
}
