/**
 * frame-template CSS 和 helper.js 内嵌资源。
 * 用于在 iframe sandbox 内渲染 HTML 片段，提供与 brainstorming skill 兼容的样式。
 */

// 从 brainstorming skill 的 frame-template.html 提取的 CSS
export const FRAME_CSS = `/*
 * BRAINSTORM COMPANION FRAME TEMPLATE
 *
 * This template provides a consistent frame with:
 * - OS-aware light/dark theming
 * - Fixed header and selection indicator bar
 * - Scrollable main content area
 * - CSS helpers for common UI patterns
 *
 * Content is injected via placeholder comment in #claude-content.
 */

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; }

/* ===== THEME VARIABLES ===== */
:root {
  --bg-primary: #f5f5f7;
  --bg-secondary: #ffffff;
  --bg-tertiary: #e5e5e7;
  --border: #d1d1d6;
  --text-primary: #1d1d1f;
  --text-secondary: #86868b;
  --text-tertiary: #aeaeb2;
  --accent: #0071e3;
  --accent-hover: #0077ed;
  --success: #34c759;
  --warning: #ff9f0a;
  --error: #ff3b30;
  --selected-bg: #e8f4fd;
  --selected-border: #0071e3;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg-primary: #1d1d1f;
    --bg-secondary: #2d2d2f;
    --bg-tertiary: #3d3d3f;
    --border: #424245;
    --text-primary: #f5f5f7;
    --text-secondary: #86868b;
    --text-tertiary: #636366;
    --accent: #0a84ff;
    --accent-hover: #409cff;
    --selected-bg: rgba(10, 132, 255, 0.15);
    --selected-border: #0a84ff;
  }
}

body {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  background: var(--bg-primary);
  color: var(--text-primary);
  display: flex;
  flex-direction: column;
  line-height: 1.5;
}

/* ===== FRAME STRUCTURE ===== */
.header {
  background: var(--bg-secondary);
  padding: 0.5rem 1.5rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.header h1 { font-size: 0.85rem; font-weight: 500; color: var(--text-secondary); }
.header .status { font-size: 0.7rem; color: var(--success); display: flex; align-items: center; gap: 0.4rem; }
.header .status::before { content: ''; width: 6px; height: 6px; background: var(--success); border-radius: 50%; }

.main { flex: 1; overflow-y: auto; }
#claude-content { padding: 2rem; min-height: 100%; }

.indicator-bar {
  background: var(--bg-secondary);
  border-top: 1px solid var(--border);
  padding: 0.5rem 1.5rem;
  flex-shrink: 0;
  text-align: center;
}
.indicator-bar span {
  font-size: 0.75rem;
  color: var(--text-secondary);
}
.indicator-bar .selected-text {
  color: var(--accent);
  font-weight: 500;
}

/* ===== TYPOGRAPHY ===== */
h2 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.5rem; }
h3 { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.25rem; }
.subtitle { color: var(--text-secondary); margin-bottom: 1.5rem; }
.section { margin-bottom: 2rem; }
.label { font-size: 0.7rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }

/* ===== OPTIONS (for A/B/C choices) ===== */
.options { display: flex; flex-direction: column; gap: 0.75rem; }
.option {
  background: var(--bg-secondary);
  border: 2px solid var(--border);
  border-radius: 12px;
  padding: 1rem 1.25rem;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: flex-start;
  gap: 1rem;
}
.option:hover { border-color: var(--accent); }
.option.selected { background: var(--selected-bg); border-color: var(--selected-border); }
.option .letter {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  width: 1.75rem; height: 1.75rem;
  border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-weight: 600; font-size: 0.85rem; flex-shrink: 0;
}
.option.selected .letter { background: var(--accent); color: white; }
.option .content { flex: 1; }
.option .content h3 { font-size: 0.95rem; margin-bottom: 0.15rem; }
.option .content p { color: var(--text-secondary); font-size: 0.85rem; margin: 0; }

/* ===== CARDS (for showing designs/mockups) ===== */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; }
.card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.15s ease;
}
.card:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
.card.selected { border-color: var(--selected-border); border-width: 2px; }
.card-image { background: var(--bg-tertiary); aspect-ratio: 16/10; display: flex; align-items: center; justify-content: center; }
.card-body { padding: 1rem; }
.card-body h3 { margin-bottom: 0.25rem; }
.card-body p { color: var(--text-secondary); font-size: 0.85rem; }

/* ===== MOCKUP CONTAINER ===== */
.mockup {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 1.5rem;
}
.mockup-header {
  background: var(--bg-tertiary);
  padding: 0.5rem 1rem;
  font-size: 0.75rem;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}
.mockup-body { padding: 1.5rem; }

/* ===== SPLIT VIEW (side-by-side comparison) ===== */
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
@media (max-width: 700px) { .split { grid-template-columns: 1fr; } }

/* ===== PROS/CONS ===== */
.pros-cons { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 1rem 0; }
.pros, .cons { background: var(--bg-secondary); border-radius: 8px; padding: 1rem; }
.pros h4 { color: var(--success); font-size: 0.85rem; margin-bottom: 0.5rem; }
.cons h4 { color: var(--error); font-size: 0.85rem; margin-bottom: 0.5rem; }
.pros ul, .cons ul { margin-left: 1.25rem; font-size: 0.85rem; color: var(--text-secondary); }
.pros li, .cons li { margin-bottom: 0.25rem; }

/* ===== PLACEHOLDER (for mockup areas) ===== */
.placeholder {
  background: var(--bg-tertiary);
  border: 2px dashed var(--border);
  border-radius: 8px;
  padding: 2rem;
  text-align: center;
  color: var(--text-tertiary);
}

/* ===== INLINE MOCKUP ELEMENTS ===== */
.mock-nav { background: var(--accent); color: white; padding: 0.75rem 1rem; display: flex; gap: 1.5rem; font-size: 0.9rem; }
.mock-sidebar { background: var(--bg-tertiary); padding: 1rem; min-width: 180px; }
.mock-content { padding: 1.5rem; flex: 1; }
.mock-button { background: var(--accent); color: white; border: none; padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.85rem; }
.mock-input { background: var(--bg-primary); border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem; width: 100%; }`;

// 改造后的 helper.js（WebSocket 替换为 postMessage，适配 GrenAgent iframe）
export const HELPER_JS = `(function() {
  // ── 原版 helper.js（WebSocket 重连逻辑在 iframe 内无效，保留结构但 connect() 是 no-op）──
  let eventQueue = [];

  function sendEvent(event) {
    event.timestamp = Date.now();
    // In GrenAgent iframe: send via postMessage to parent instead of WebSocket
    notifyChoice(event);
  }

  // Capture clicks on choice elements
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-choice]');
    if (!target) return;

    sendEvent({
      type: 'click',
      text: target.textContent.trim(),
      choice: target.dataset.choice,
      id: target.id || null
    });

    // Update indicator bar (defer so toggleSelect runs first)
    setTimeout(() => {
      const indicator = document.getElementById('indicator-text');
      if (!indicator) return;
      const container = target.closest('.options') || target.closest('.cards');
      const selected = container ? container.querySelectorAll('.selected') : [];
      if (selected.length === 0) {
        indicator.textContent = 'Click an option above, then return to the terminal';
      } else if (selected.length === 1) {
        const label = selected[0].querySelector('h3, .content h3, .card-body h3')?.textContent?.trim() || selected[0].dataset.choice;
        indicator.innerHTML = '<span class="selected-text">' + label + ' selected</span> — return to terminal to continue';
      } else {
        indicator.innerHTML = '<span class="selected-text">' + selected.length + ' selected</span> — return to terminal to continue';
      }
    }, 0);
  });

  // Frame UI: selection tracking
  window.selectedChoice = null;

  window.toggleSelect = function(el) {
    const container = el.closest('.options') || el.closest('.cards');
    const multi = container && container.dataset.multiselect !== undefined;
    if (container && !multi) {
      container.querySelectorAll('.option, .card').forEach(o => o.classList.remove('selected'));
    }
    if (multi) {
      el.classList.toggle('selected');
    } else {
      el.classList.add('selected');
    }
    window.selectedChoice = el.dataset.choice;
  };

  // Expose API for explicit use
  window.brainstorm = {
    send: sendEvent,
    choice: (value, metadata = {}) => sendEvent({ type: 'choice', value, ...metadata })
  };

  // ── GrenAgent iframe 扩展：postMessage 到父窗口 ──
  function notifyChoice(event) {
    if (!event.choice) return;
    const text = event.text || event.choice;
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'visual-choice', choice: event.choice, text }, '*');
    }
  }

  // 高度通知：DOM 渲染完成后告知父窗口实际内容高度
  function notifyResize() {
    const height = document.documentElement.scrollHeight || document.body.scrollHeight;
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'visual-resize', height }, '*');
    }
  }

  window.addEventListener('DOMContentLoaded', notifyResize);
  window.addEventListener('load', notifyResize);
})();`;

/**
 * 把 HTML 片段（或完整文档）包裹进 frame-template，注入 helper.js。
 * 完整文档（以 <!DOCTYPE 或 <html 开头）只注入 helper.js；其余作为片段包裹。
 */
export function buildSrcDoc(html: string): string {
  const isFullDoc = /^\s*<!doctype|^\s*<html/i.test(html);
  const helperTag = `<script>\n${HELPER_JS}\n</script>`;

  if (isFullDoc) {
    return html.includes('</body>')
      ? html.replace('</body>', `${helperTag}\n</body>`)
      : html + helperTag;
  }

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${FRAME_CSS}</style>
</head>
<body>
<div id="claude-content">
${html}
</div>
${helperTag}
</body>
</html>`;
}
