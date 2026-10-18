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
/* 方案多了按最小宽度折行，不再固定两列把每张卡挤窄。 */
.split { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 14px; align-items: stretch; }
.split > * { min-width: 0; }

/* ===== PROS/CONS ===== */
.pros-cons { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 10px; margin: 10px 0; }
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

  let submitted = false;

  function choiceOf(el) {
    return el.dataset.choice || el.dataset.value || '';
  }

  function labelOf(el) {
    return el.querySelector('h3, .content h3, .card-body h3')?.textContent?.trim() || choiceOf(el);
  }

  function hasChoices() {
    return !!document.querySelector('[data-choice], [data-value]');
  }

  function selectedNodes() {
    const seen = new Set();
    const out = [];
    document.querySelectorAll('[data-choice].selected, [data-value].selected').forEach((el) => {
      if (seen.has(el) || !choiceOf(el)) return;
      seen.add(el);
      out.push(el);
    });
    return out;
  }

  function sendEvent(event) {
    event.timestamp = Date.now();
    if (event.type === 'submit') notifyChoice(event);
    else stageChoice(event);
  }

  // 点选项只选中。页面设计里选项常用来切换方案，提交交给底部确认按钮。
  document.addEventListener('click', (e) => {
    if (submitted) return;
    const target = e.target.closest('[data-choice], [data-value]');
    if (!target || target.closest('#visual-confirm-bar')) return;
    const onclick = target.getAttribute('onclick') || '';
    if (!onclick.includes('toggleSelect')) window.toggleSelect(target);
    refreshConfirm();

    setTimeout(() => {
      const indicator = document.getElementById('indicator-text');
      if (!indicator) return;
      const nodes = selectedNodes();
      if (nodes.length === 0) {
        indicator.textContent = 'Select a scheme, then confirm the page';
      } else if (nodes.length === 1) {
        indicator.innerHTML = '<span class="selected-text">' + labelOf(nodes[0]) + ' selected</span> — confirm to continue';
      } else {
        indicator.innerHTML = '<span class="selected-text">' + nodes.length + ' selected</span> — confirm to continue';
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
    window.selectedChoice = el.dataset.choice || el.dataset.value;
  };

  // Expose API for explicit use. choice 只选中，不提交。
  window.brainstorm = {
    send: sendEvent,
    choice: (value, metadata = {}) => stageChoice({ type: 'choice', choice: value, text: metadata.text, ...metadata })
  };

  function stageChoice(event) {
    const choice = event.choice || event.value;
    if (!choice || submitted) return;
    const el = document.querySelector('[data-choice="' + CSS.escape(choice) + '"], [data-value="' + CSS.escape(choice) + '"]');
    if (el) window.toggleSelect(el);
    else window.selectedChoice = choice;
    refreshConfirm();
  }

  // ── GrenAgent iframe 扩展：只有确认按钮 postMessage 到父窗口 ──
  // 选项可选：没选任何方案直接确认时 choice 是空串，所以这里只要求它是字符串。
  function notifyChoice(event) {
    if (typeof event.choice !== 'string' || submitted) return;
    submitted = true;
    const text = event.text || event.choice;
    const supplement = currentSupplement();
    const btn = document.getElementById('visual-confirm-btn');
    const hint = document.getElementById('visual-confirm-hint');
    const noteBtn = document.getElementById('visual-note-btn');
    const note = document.getElementById('visual-note');
    const panel = document.getElementById('visual-note-panel');
    if (btn) { btn.disabled = true; btn.textContent = '已提交'; }
    if (noteBtn) noteBtn.disabled = true;
    if (note) note.disabled = true;
    if (panel) panel.hidden = true;
    if (hint) hint.textContent = '已提交：' + text;
    if (window.parent && window.parent !== window) {
      const message = { type: 'visual-choice', choice: event.choice, text };
      if (supplement) message.supplement = supplement;
      window.parent.postMessage(message, '*');
    }
  }

  // 「补充」是可选的自由说明：不填也能提交。
  function currentSupplement() {
    const note = document.getElementById('visual-note');
    return note ? note.value.trim() : '';
  }

  // 只有页面明确标了 data-required 的选项组才是必选；其余选项默认可选、可跳过。
  // 必选要说明原因：data-required-reason 的文字会显示在确认条上。
  function missingRequired() {
    return Array.prototype.filter.call(document.querySelectorAll('[data-required]'), (group) => {
      return !group.querySelector('[data-choice].selected, [data-value].selected');
    });
  }

  function submitSelection() {
    if (submitted) return;
    const nodes = selectedNodes();
    if (hasChoices()) {
      if (missingRequired().length) return;
      if (!nodes.length) {
        notifyChoice({ choice: '', text: '未选择（已跳过）' });
        return;
      }
      notifyChoice({
        choice: nodes.map(choiceOf).join(','),
        text: nodes.map(labelOf).join('、')
      });
      return;
    }
    notifyChoice({ choice: 'confirm', text: '确定页面' });
  }

  function refreshConfirm() {
    ensureConfirmBar();
    const btn = document.getElementById('visual-confirm-btn');
    const hint = document.getElementById('visual-confirm-hint');
    if (!btn || !hint || submitted) return;
    const nodes = selectedNodes();
    refreshNoteButton();
    if (hasChoices()) {
      btn.textContent = '确认提交';
      const missing = missingRequired();
      if (missing.length) {
        btn.disabled = true;
        hint.textContent = '必选：' + (missing[0].getAttribute('data-required-reason') || '请先选择一项');
        return;
      }
      if (!nodes.length) {
        btn.disabled = false;
        hint.textContent = '选项可选，可直接提交，也可写补充';
        return;
      }
      btn.disabled = false;
      hint.textContent = nodes.length === 1 ? ('已选：' + labelOf(nodes[0])) : ('已选 ' + nodes.length + ' 项');
      return;
    }
    btn.disabled = false;
    btn.textContent = '确定页面';
    hint.textContent = '确认当前页面';
  }

  function refreshNoteButton() {
    const noteBtn = document.getElementById('visual-note-btn');
    if (!noteBtn || submitted) return;
    noteBtn.textContent = currentSupplement() ? '补充（已填）' : '补充';
  }

  function ensureConfirmBar() {
    if (document.getElementById('visual-confirm-bar')) return;
    const page = document.querySelector('.mockup, .split, .cards, .option, [data-choice], [data-value]');
    if (!page) return;
    const style = document.createElement('style');
    style.id = 'visual-confirm-style';
    style.textContent = [
      'body.visual-has-confirm { padding-bottom: 64px !important; }',
      '#visual-confirm-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483646;',
      'display: flex; align-items: center; justify-content: space-between; gap: 12px;',
      'padding: 10px 14px; background: rgba(15,15,18,0.94); border-top: 1px solid #2e2e38;',
      "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }",
      '#visual-confirm-hint { font-size: 13px; color: #8888a0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '#visual-confirm-btn { flex-shrink: 0; border: none; border-radius: 8px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; background: #7c7cf8; color: #fff; }',
      '#visual-confirm-btn:disabled { cursor: default; background: #2a2a36; color: #6a6a80; }',
      '#visual-note-btn { flex-shrink: 0; border: 1px solid #2e2e38; border-radius: 8px; padding: 7px 12px; font-size: 13px; cursor: pointer; background: transparent; color: #c8c8d8; }',
      '#visual-note-btn:disabled { cursor: default; color: #6a6a80; }',
      '#visual-note-panel { position: absolute; left: 14px; right: 14px; bottom: 100%; margin-bottom: 8px; padding: 8px; background: rgba(15,15,18,0.97); border: 1px solid #2e2e38; border-radius: 10px; }',
      '#visual-note-panel[hidden] { display: none; }',
      '#visual-note { display: block; width: 100%; min-height: 64px; max-height: 160px; resize: vertical; box-sizing: border-box; background: #18181f; color: #e8e8f0; border: 1px solid #2e2e38; border-radius: 6px; padding: 7px 9px; font: inherit; font-size: 13px; outline: none; }',
      '#visual-note:focus { border-color: #4a4a60; }'
    ].join('');
    const bar = document.createElement('div');
    bar.id = 'visual-confirm-bar';
    bar.innerHTML = '<span id="visual-confirm-hint"></span>' +
      '<button type="button" id="visual-note-btn">补充</button>' +
      '<button type="button" id="visual-confirm-btn"></button>' +
      '<div id="visual-note-panel" hidden><textarea id="visual-note" placeholder="补充说明（可选）：想改哪里、有什么顾虑，都可以写在这里"></textarea></div>';
    document.body.appendChild(style);
    document.body.appendChild(bar);
    document.body.classList.add('visual-has-confirm');
    bar.querySelector('#visual-confirm-btn').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      submitSelection();
    });
    bar.querySelector('#visual-note-btn').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const panel = document.getElementById('visual-note-panel');
      const note = document.getElementById('visual-note');
      if (!panel || submitted) return;
      panel.hidden = !panel.hidden;
      if (!panel.hidden && note) note.focus();
    });
    bar.querySelector('#visual-note').addEventListener('input', refreshNoteButton);
  }

  // 高度通知：DOM 渲染完成后告知父窗口实际内容高度
  function notifyResize() {
    const height = document.documentElement.scrollHeight || document.body.scrollHeight;
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'visual-resize', height }, '*');
    }
  }

  window.addEventListener('DOMContentLoaded', () => { refreshConfirm(); notifyResize(); });
  window.addEventListener('load', notifyResize);
  refreshConfirm();
})();`;

/** 整页文档没有 frame CSS，补上折行；面板模式再把比较区撑满 iframe。 */
const LAYOUT_PATCH = `
.split { display: grid !important; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)) !important; gap: 14px; align-items: stretch; }
.cards { display: grid !important; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)) !important; gap: 10px; align-items: stretch; }
.pros-cons { display: grid !important; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)) !important; }
.split > *, .cards > * { min-width: 0 !important; }
`;

const FILL_PATCH = `
/* html 定高、body 用 min-height：内容矮时比较区撑满剩余空间，内容高时 body 跟着长、整页滚动。
   body 定高的话，溢出的内容后面没有底边距，确认条给 body 留的 padding-bottom 不起作用，最后一个选项会被条盖住。 */
html { height: 100% !important; }
body { height: auto !important; min-height: 100% !important; box-sizing: border-box !important; display: flex !important; flex-direction: column !important; }
/* 确认条的 style 挂在 body 上。display 一旦不是 none，浏览器会把 CSS 原文画进页面。
   确认条本身也是 body 的直接子节点：它是 fixed 的单行横条，被改成竖向 flex 会变成两行高，盖住底部的选项。 */
body > *:not(script):not(style):not(#visual-confirm-bar), #claude-content { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
h1, h2, h3, h4, p, .subtitle, .label, .options, .option { flex: 0 0 auto !important; }
.split, .cards { flex: 1 1 auto !important; min-height: 0 !important; }
.mockup { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; margin-bottom: 0; }
.mockup-body { flex: 1 1 auto; overflow: auto; }
`;

function injectStyle(html: string, css: string): string {
  const tag = `<style data-visual-layout>${css}</style>`;
  if (html.includes('</head>')) return html.replace('</head>', `${tag}</head>`);
  if (html.includes('</body>')) return html.replace('</body>', `${tag}</body>`);
  return `${tag}${html}`;
}

/**
 * 把 HTML 片段（或完整文档）包裹进 frame-template，注入 helper.js。
 * 完整文档（以 <!DOCTYPE 或 <html 开头）只注入 helper.js 和折行补丁；其余作为片段包裹。
 * fill 用于右侧面板：比较区撑满 iframe，聊天里的内联卡片保持内容高度。
 */
export function buildSrcDoc(html: string, options?: { fill?: boolean }): string {
  const isFullDoc = /^\s*<!doctype|^\s*<html/i.test(html);
  const helperTag = `<script>\n${HELPER_JS}\n</script>`;
  const patch = `${isFullDoc ? LAYOUT_PATCH : ''}${options?.fill ? FILL_PATCH : ''}`;

  if (isFullDoc) {
    const withHelper = html.includes('</body>')
      ? html.replace('</body>', `${helperTag}\n</body>`)
      : html + helperTag;
    return patch ? injectStyle(withHelper, patch) : withHelper;
  }

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${FRAME_CSS}</style>
${patch ? `<style data-visual-layout>${patch}</style>` : ''}
</head>
<body>
<div id="claude-content">
${html}
</div>
${helperTag}
</body>
</html>`;
}
