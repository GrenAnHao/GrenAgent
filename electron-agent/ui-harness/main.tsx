import type { ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import HarnessRoot from './HarnessRoot'
import { forceEagerImages } from '../src/lib/forceEagerImages'
// 和 src/main.tsx 一样：全局样式 + 图片强制 eager
import '../src/index.css'

forceEagerImages()

type ScenarioModule = { default: ComponentType }
type UiWindow = { __uiErrors: string[] }

// 每个场景一个文件，地址里的 #名字 决定加载哪一个
const scenarios = import.meta.glob<ScenarioModule>('./scenarios/*.tsx')
const ui = window as unknown as UiWindow

// 页面里任何未捕获的错误都记下来，run.mjs 结束时据此判失败
ui.__uiErrors = []
window.addEventListener('error', (event) => ui.__uiErrors.push(String(event.message)))
window.addEventListener('unhandledrejection', (event) => ui.__uiErrors.push(String(event.reason)))

async function boot(): Promise<void> {
  const name = decodeURIComponent(location.hash.slice(1))
  const load = scenarios[`./scenarios/${name}.tsx`]
  if (!load) {
    ui.__uiErrors.push(`没有这个场景：${name}`)
    return
  }
  const { default: Scenario } = await load()
  createRoot(document.getElementById('root')!).render(
    <HarnessRoot>
      <Scenario />
    </HarnessRoot>
  )
}

void boot()
