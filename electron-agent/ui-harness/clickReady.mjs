// Summaries go into failure attachments. Never copy selector values, DOM text, ids or classes.
const tags = 'a article aside body button canvas div form header html input label li main nav ol option p section select span svg textarea ul'.split(' ')

function selectorShape(selector) {
  // Recognize a small, whole-selector grammar. Unknown syntax is redacted as a unit.
  const parts = []
  const token = /\s+|>|#[\w-]+|\.[\w-]+|\[(data-testid|data-case|role|type)(?:=["'][^"'\\\]]*["'])?\]|[a-z][a-z0-9-]*/gy
  for (let i = 0; i < selector.length;) {
    const m = token.exec(selector)
    if (!m || parts.length >= 16) return '<selector>'
    const s = m[0]
    parts.push(m[1] ? '[' + m[1] + ']' : s[0] === '#' ? '#…' : s[0] === '.' ? '.…' :
      s.trim() === '' ? ' ' : s === '>' || tags.includes(s) ? s : '*')
    i = token.lastIndex
  }
  return parts.join('')
}

// Runs in Chromium: keep node identity and the stable interval local to this single wait.
function waitForPoint(selector, dx, timeoutMs, stableMs, tags) {
  return new Promise((resolve) => {
    let observed, point, since, hit, reason
    let frame
    const deadline = performance.now() + timeoutMs
    function describe(el) {
      if (!el) return null
      const path = []
      for (let depth = 0; el && depth < 3; depth++, el = el.parentElement) {
        let index = 1
        for (let prev = el.previousElementSibling; prev; prev = prev.previousElementSibling)
          if (prev.localName === el.localName) index++
        path.unshift((tags.includes(el.localName) ? el.localName : '*') + ':nth-of-type(' + index + ')')
      }
      return path.join(' > ')
    }
    function finish(ready) {
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      resolve(ready ? { point } : { point, reason, target: describe(observed), hit: describe(hit) })
    }
    function sample(expired = false) {
      const now = performance.now()
      let el
      try { el = document.querySelector(selector) } catch {
        reason = 'invalid-selector'
        return finish(false)
      }
      if (observed !== el) {
        observed = el
        since = undefined
        // Chromium centers only if clipped (including nested scroll containers). Once per mount.
        el?.scrollIntoViewIfNeeded(true)
      }
      const previous = point
      const rect = el?.getBoundingClientRect()
      point = rect?.width && rect.height
        ? { x: Math.round(rect.left + dx), y: Math.round(rect.top + rect.height / 2) } : null
      hit = point ? document.elementFromPoint(point.x, point.y) : null
      if (!el) reason = 'not-found'
      else if (el.closest(':disabled, [aria-disabled="true" i], [inert]')) reason = 'disabled'
      else if (!point || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) reason = 'hidden'
      else if (point.x < 0 || point.x >= innerWidth || point.y < 0 || point.y >= innerHeight) reason = 'outside-viewport'
      else if (!el.contains(hit) || !hit) reason = 'obscured'
      else {
        if (since === undefined || point.x !== previous?.x || point.y !== previous?.y) since = now
        reason = 'unstable'
        if (!expired && now < deadline && now - since >= stableMs) return finish(true)
      }
      if (reason !== 'unstable') since = undefined
      if (expired || now >= deadline) return finish(false)
      frame = requestAnimationFrame(() => sample())
    }
    const timer = setTimeout(() => sample(true), timeoutMs)
    sample()
  })
}

export class ClickReadyError extends Error {
  constructor(details) {
    const { selector, point, reason, hit } = details
    super(`clickReady ${selector}: ${reason}; point=${point ? point.x + ',' + point.y : 'unknown'}; hit=${hit ?? 'unknown'}`)
    this.name = 'ClickReadyError'
    this.details = details
  }
}

export function createClickReady({ js, click }) {
  return async function clickReady(selector, { dx = 6, timeoutMs = 4000, stableMs = 300 } = {}) {
    if (typeof selector !== 'string' || !selector.trim()) throw new TypeError('clickReady requires a selector')
    if (!Number.isFinite(dx) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
        !Number.isFinite(stableMs) || stableMs < 0) throw new RangeError('Invalid clickReady offsets or time limits')
    const args = [selector, dx, timeoutMs, stableMs, tags].map((arg) => JSON.stringify(arg)).join(',')
    // A hung renderer cannot run its own deadline. The main-process backstop never dispatches input.
    let timer
    let result
    try {
      result = await Promise.race([
        js('(' + waitForPoint + ')(' + args + ')'),
        new Promise((resolve) => { timer = setTimeout(() => resolve({
          reason: 'renderer-timeout', point: null, target: null, hit: null
        }), timeoutMs + 150) })
      ])
    } finally {
      clearTimeout(timer)
    }
    if (result.reason) throw new ClickReadyError({ selector: selectorShape(selector), ...result })
    return click(result.point)
  }
}
