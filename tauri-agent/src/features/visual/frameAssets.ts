/**
 * frame-template CSS 和 helper.js 内嵌资源。
 * 用于在 iframe sandbox 内渲染 HTML 片段，提供与 brainstorming skill 兼容的样式。
 */

// 从 brainstorming skill 的 frame-template.html 提取的 CSS
// 强制深色主题（Tauri WebView 内 prefers-color-scheme 不可靠，直接写死深色变量）
export const FRAME_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: auto; overflow: visible; }

/* ===== THEME VARIABLES — 固定深色，与 GrenAgent 界面一致 ===== */
:root {
  --bg-primary: #141416;
  --bg-secondary: #1e1e22;
  --bg-tertiary: #28282e;
  --border: rgba(255,255,255,0.08);
  --border-strong: rgba(255,255,255,0.14);
  --text-primary: #f0f0f2;
  --text-secondary: #8c8c99;
  --text-tertiary: #55555e;
  --accent: #6366f1;
  --accent-hover: #818cf8;
  --accent-dim: rgba(99,102,241,0.15);
  --success: #22c55e;
  --warning: #f59e0b;
  --error: #ef4444;
  --selected-bg: rgba(99,102,241,0.12);
  --selected-border: #6366f1;
  --radius: 10px;
}

body {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg-primary);
  color: var(--text-primary);
  line-height: 1.55;
  padding: 16px;
  font-size: 14px;
}

/* ===== TYPOGRAPHY ===== */
h2 { font-size: 1.25rem; font-weight: 700; margin-bottom: 4px; color: var(--text-primary); }
h3 { font-size: 0.95rem; font-weight: 600; margin-bottom: 2px; color: var(--text-primary); }
h4 { font-size: 0.85rem; font-weight: 600; margin-bottom: 6px; }
p { color: var(--text-secondary); font-size: 0.88rem; margin: 0; }
code { font-family: 'Fira Code', 'Cascadia Code', monospace; font-size: 0.82rem; background: var(--bg-tertiary); border-radius: 4px; padding: 1px 5px; }
.subtitle { color: var(--text-secondary); margin-bottom: 16px; font-size: 0.88rem; }
.section { margin-bottom: 20px; }
.label { font-size: 0.7rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 8px; display: block; }

/* ===== OPTIONS (A/B/C choices) ===== */
.options { display: flex; flex-direction: column; gap: 8px; }
.option {
  background: var(--bg-secondary);
  border: 1.5px solid var(--border-strong);
  border-radius: var(--radius);
  padding: 12px 16px;
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
  display: flex;
  align-items: center;
  gap: 12px;
  user-select: none;
}
.option:hover { border-color: var(--accent); background: var(--bg-tertiary); }
.option.selected { background: var(--selected-bg); border-color: var(--selected-border); }
.option .letter {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  width: 28px; height: 28px; min-width: 28px;
  border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 0.82rem; flex-shrink: 0;
  border: 1px solid var(--border-strong);
}
.option.selected .letter { background: var(--accent); color: #fff; border-color: transparent; }
.option .content { flex: 1; min-width: 0; }
.option .content h3 { font-size: 0.9rem; margin-bottom: 0; }
.option .content p { color: var(--text-secondary); font-size: 0.82rem; margin-top: 2px; }

/* ===== CARDS ===== */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.card {
  background: var(--bg-secondary);
  border: 1.5px solid var(--border-strong);
  border-radius: var(--radius);
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.12s, transform 0.12s;
}
.card:hover { border-color: var(--accent); transform: translateY(-2px); }
.card.selected { border-color: var(--selected-border); border-width: 2px; }
.card-image { background: var(--bg-tertiary); aspect-ratio: 16/10; display: flex; align-items: center; justify-content: center; color: var(--text-tertiary); font-size: 0.8rem; }
.card-body { padding: 12px; }
.card-body h3 { margin-bottom: 4px; }
.card-body p { color: var(--text-secondary); font-size: 0.82rem; }

/* ===== MOCKUP ===== */
.mockup { background: var(--bg-secondary); border: 1px solid var(--border-strong); border-radius: var(--radius); overflow: hidden; margin-bottom: 16px; }
.mockup-header { background: var(--bg-tertiary); padding: 8px 14px; font-size: 0.75rem; color: var(--text-secondary); border-bottom: 1px solid var(--border); }
.mockup-body { padding: 16px; }

/* ===== SPLIT VIEW ===== */
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 640px) { .split { grid-template-columns: 1fr; } }

/* ===== PROS/CONS ===== */
.pros-cons { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 12px 0; }
.pros, .cons { background: var(--bg-secondary); border-radius: 8px; padding: 12px; border: 1px solid var(--border); }
.pros h4 { color: var(--success); }
.cons h4 { color: var(--error); }
.pros ul, .cons ul { margin-left: 16px; font-size: 0.85rem; color: var(--text-secondary); }
.pros li, .cons li { margin-bottom: 4px; }

/* ===== PLACEHOLDER ===== */
.placeholder { background: var(--bg-tertiary); border: 2px dashed var(--border-strong); border-radius: 8px; padding: 24px; text-align: center; color: var(--text-tertiary); font-size: 0.85rem; }

/* ===== INLINE MOCKUP ELEMENTS ===== */
.mock-nav { background: var(--bg-tertiary); color: var(--text-primary); padding: 10px 16px; display: flex; gap: 20px; font-size: 0.88rem; border-bottom: 1px solid var(--border); }
.mock-sidebar { background: var(--bg-secondary); padding: 12px; min-width: 160px; border-right: 1px solid var(--border); }
.mock-content { padding: 16px; flex: 1; }
.mock-button { background: var(--accent); color: white; border: none; padding: 8px 16px; border-radius: 6px; font-size: 0.85rem; cursor: pointer; }
.mock-button:hover { background: var(--accent-hover); }
.mock-input { background: var(--bg-secondary); border: 1px solid var(--border-strong); border-radius: 6px; padding: 8px 10px; width: 100%; color: var(--text-primary); font-size: 0.88rem; }

/* ===== 指示条（inline 时隐藏，保留功能性） ===== */
.indicator-bar { display: none; }
.header { display: none; }
#claude-content { padding: 0; }`;

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
