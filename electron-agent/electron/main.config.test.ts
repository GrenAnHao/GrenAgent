import { describe, expect, it } from 'vitest'
import { browserWindowOptions } from './mainConfig'

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
  })
})
