import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { browserWindowOptions, resolveAppIcon, resolveRendererHtml } from './mainConfig'

describe('browserWindowOptions', () => {
  it('enables required BrowserWindow security settings', () => {
    expect(browserWindowOptions.width).toBe(1200)
    expect(browserWindowOptions.height).toBe(800)
    expect(browserWindowOptions.minWidth).toBe(720)
    expect(browserWindowOptions.minHeight).toBe(520)
    expect(browserWindowOptions.backgroundColor).toBe('#0b0d12')
    expect(browserWindowOptions.webPreferences).toMatchObject({
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    })
    expect(browserWindowOptions.webPreferences.preload).toMatch(/preload\\preload\.js$/)
    expect(browserWindowOptions.icon).toBeUndefined()
  })

  it('resolves the packaged renderer from the app root, not out/main', () => {
    const appPath = join('C:', 'app.asar')
    expect(resolveRendererHtml(appPath)).toBe(join(appPath, 'dist', 'index.html'))
    expect(resolveRendererHtml(appPath)).not.toBe(join(appPath, 'out', 'dist', 'index.html'))
  })
})

describe('resolveAppIcon', () => {
  it('resolves the repo build ico while unpackaged', () => {
    const mainDir = join('C:', 'proj', 'out', 'main')
    expect(resolveAppIcon(false, join('C:', 'app.asar'), mainDir)).toBe(
      join('C:', 'proj', 'build', 'icon.ico'),
    )
  })

  it('resolves the asar build ico when packaged and ignores mainDir', () => {
    const appPath = join('C:', 'app.asar')
    expect(resolveAppIcon(true, appPath, join('C:', 'proj', 'out', 'main'))).toBe(
      join(appPath, 'build', 'icon.ico'),
    )
  })
})
