/**
 * frame-template CSS 和 helper.js 内嵌资源。
 * 用于在 iframe sandbox 内渲染 HTML 片段，提供与 brainstorming skill 兼容的样式。
 */

// 从 brainstorming skill 的 frame-template.html 提取的 CSS
// 强制深色主题（Tauri WebView 内 prefers-color-scheme 不可靠，直接写死深色变量）
export const FRAME_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: auto !important; overflow: visible !important; }

/* ===== THEME VARIABLES ===== */
:root {
  --bg-primary: #0f0f12;
  --bg-card: #18181f;
  --bg-hover: #22222c;
  --border: #2e2e38;
  --border-accent: #4a4a60;
  --text-primary: #e8e8f0;
  --text-secondary: #8888a0;
  --text-muted: #505065;
  --accent: #7c7cf8;
  --accent-bg: rgba(124,124,248,0.18);
  --accent-border: rgba(124,124,248,0.55);
  --success: #4ade80;
  --error: #f87171;
  --radius: 10px;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: var(--bg-primary);
  color: var(--text-primary);
  line-height: 1.55;
  padding: 14px 16px 16px;
  font-size: 14px;
}

/* ===== TYPOGRAPHY ===== */
h2 { font-size: 1.15rem; font-weight: 700; margin-bottom: 4px; }
h3 { font-size: 0.92rem; font-weight: 600; margin-bottom: 1px; color: var(--text-primary); }
h4 { font-size: 0.84rem; font-weight: 600; margin-bottom: 6px; }
p, .desc { color: var(--text-secondary); font-size: 0.84rem; margin: 0; line-height: 1.45; }
code { font-size: 0.8rem; background: #22222c; border-radius: 4px; padding: 1px 5px; color: #a5b4fc; }
.subtitle { color: var(--text-secondary); margin-bottom: 14px; font-size: 0.85rem; }
.section { margin-bottom: 18px; }
.label { font-size: 0.68rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; display: block; }

/* ===== OPTIONS ===== */
.options { display: flex; flex-direction: column; gap: 7px; }
.option {
  background: var(--bg-card);
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  padding: 11px 14px;
  cursor: pointer;
  transition: border-color 0.1s, background 0.1s;
  display: flex;
  align-items: center;
  gap: 11px;
  user-select: none;
  -webkit-user-select: none;
}
.option:hover { border-color: var(--border-accent); background: var(--bg-hover); }
.option.selected { background: var(--accent-bg); border-color: var(--accent-border); }
.option .letter {
  width: 26px; height: 26px; min-width: 26px;
  border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 0.78rem;
  flex-shrink: 0;
  background: #28283a;
  color: var(--text-secondary);
  border: 1px solid var(--border);
}
.option.selected .letter { background: var(--accent); color: #fff; border-color: transparent; }
.option .content { flex: 1; min-width: 0; }
.option .content h3 { font-size: 0.88rem; }
.option .content p { margin-top: 1px; }

/* ===== CARDS ===== */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.card { background: var(--bg-card); border: 1.5px solid var(--border); border-radius: var(--radius); overflow: hidden; cursor: pointer; transition: border-color 0.1s; }
.card:hover { border-color: var(--border-accent); }
.card.selected { border-color: var(--accent-border); border-width: 2px; }
.card-image { background: #22222c; aspect-ratio: 16/10; display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: 0.78rem; }
.card-body { padding: 11px; }
.card-body h3 { margin-bottom: 3px; }

/* ===== MOCKUP ===== */
.mockup { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin-bottom: 14px; }
.mockup-header { background: #1c1c25; padding: 7px 12px; font-size: 0.73rem; color: var(--text-secondary); border-bottom: 1px solid var(--border); }
.mockup-body { padding: 14px; }

/* ===== SPLIT ===== */
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 600px) { .split { grid-template-columns: 1fr; } }

/* ===== PROS/CONS ===== */
.pros-cons { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0; }
.pros, .cons { background: var(--bg-card); border-radius: 8px; padding: 11px; border: 1px solid var(--border); }
.pros h4 { color: var(--success); }
.cons h4 { color: var(--error); }
.pros ul, .cons ul { margin-left: 15px; font-size: 0.83rem; color: var(--text-secondary); }
.pros li, .cons li { margin-bottom: 3px; }

/* ===== MISC ===== */
.placeholder { background: #1c1c25; border: 1.5px dashed var(--border); border-radius: 8px; padding: 20px; text-align: center; color: var(--text-muted); font-size: 0.83rem; }
.mock-nav { background: #22222c; color: var(--text-primary); padding: 9px 14px; display: flex; gap: 18px; font-size: 0.85rem; border-bottom: 1px solid var(--border); }
.mock-sidebar { background: var(--bg-card); padding: 11px; min-width: 140px; border-right: 1px solid var(--border); }
.mock-content { padding: 14px; flex: 1; }
.mock-button { background: var(--accent); color: #fff; border: none; padding: 7px 14px; border-radius: 6px; font-size: 0.83rem; cursor: pointer; }
.mock-input { background: var(--bg-card); border: 1.5px solid var(--border); border-radius: 6px; padding: 7px 10px; width: 100%; color: var(--text-primary); font-size: 0.85rem; outline: none; }
.mock-input:focus { border-color: var(--border-accent); }

/* 隐藏原版 frame 的 header/footer（内联不需要） */
.indicator-bar, .header { display: none !important; }
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
