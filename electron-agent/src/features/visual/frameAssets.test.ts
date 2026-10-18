import { describe, expect, it } from 'vitest';
import { buildSrcDoc, HELPER_JS } from './frameAssets';

function displayRules(doc: Document): string[] {
  const selectors: string[] = [];
  for (const sheet of [...doc.styleSheets]) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of [...rules]) {
      if (rule.type !== CSSRule.STYLE_RULE || !('style' in rule)) continue;
      const display = (rule as CSSStyleRule).style.getPropertyValue('display');
      if (display && display !== 'none') selectors.push((rule as CSSStyleRule).selectorText);
    }
  }
  return selectors;
}

function mountPreview(body: string) {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) throw new Error('iframe unavailable');
  doc.open();
  doc.write(`<!DOCTYPE html><html><body>${body}</body></html>`);
  doc.close();
  win.eval(HELPER_JS);
  return { doc, iframe };
}

describe('buildSrcDoc', () => {
  it('wraps fragments and keeps them content-sized', () => {
    const doc = buildSrcDoc('<div class="split"><div class="mockup">A</div><div class="mockup">B</div></div>');
    expect(doc).toContain('auto-fit');
    expect(doc).toContain('minmax(min(100%, 420px), 1fr)');
    expect(doc).not.toContain('grid-template-columns: 1fr 1fr');
    expect(doc).not.toContain('data-visual-layout');
  });

  it('fills the viewport only when the panel asks for it', () => {
    const doc = buildSrcDoc('<div class="split"></div>', { fill: true });
    expect(doc).toContain('data-visual-layout');
    expect(doc).toContain('.split, .cards { flex: 1 1 auto !important');
  });

  it('lets the body grow past the viewport so the confirm bar padding stays effective', () => {
    const doc = buildSrcDoc('<div class="split"></div>', { fill: true });
    expect(doc).toContain('html { height: 100% !important; }');
    expect(doc).toContain('body { height: auto !important; min-height: 100% !important;');
    // body 定高时，溢出内容后面没有 padding-bottom，最后一个选项会被确认条盖住
    expect(doc).not.toMatch(/html, body \{ height: 100% !important/);
  });

  it('keeps the fill layout off the confirm bar so it stays a single row', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error('iframe unavailable');
    doc.open();
    doc.write(buildSrcDoc('<div class="split"><div class="mockup">A</div></div>', { fill: true }));
    doc.close();
    if (!doc.getElementById('visual-confirm-bar')) (win as Window & { eval: (code: string) => unknown }).eval(HELPER_JS);

    const bar = doc.getElementById('visual-confirm-bar');
    expect(bar).toBeTruthy();
    // 确认条是 body 的直接子节点：撑满规则若命中它，flex-direction: column 会把条竖排成两行、盖住选项
    const layoutRules = displayRules(doc).filter((selector) => bar!.matches(selector));
    expect(layoutRules).toEqual(['#visual-confirm-bar']);

    iframe.remove();
  });

  it('does not paint the confirm stylesheet as page text when the panel fills', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error('iframe unavailable');
    doc.open();
    doc.write(buildSrcDoc('<div class="split"><div class="mockup">A</div></div>', { fill: true }));
    doc.close();
    if (!doc.getElementById('visual-confirm-bar')) win.eval(HELPER_JS);

    const style = doc.getElementById('visual-confirm-style');
    expect(style).toBeTruthy();
    const paintedBy = displayRules(doc).filter((selector) => style!.matches(selector));
    expect(paintedBy).toEqual([]);

    iframe.remove();
  });

  it('patches full documents so extra options wrap', () => {
    const doc = buildSrcDoc('<!DOCTYPE html><html><head></head><body><div class="split"></div></body></html>');
    expect(doc).toContain('data-visual-layout');
    expect(doc).toContain('repeat(auto-fit, minmax(min(100%, 420px), 1fr))');
    expect(doc).not.toContain('height: 100% !important');
    expect(doc).toContain('visual-choice');
    expect(doc).toContain('确认提交');
  });
});

describe('visual choice confirm', () => {
  it('lets a page design switch schemes before confirm submits', async () => {
    const messages: Array<{ type?: string; choice?: string; text?: string }> = [];
    const onMessage = (event: MessageEvent) => {
      if (event.data && typeof event.data === 'object') messages.push(event.data);
    };
    window.addEventListener('message', onMessage);
    const { doc, iframe } = mountPreview(`
      <div class="options">
        <div class="option" data-choice="a" onclick="toggleSelect(this)"><h3>方案 A</h3></div>
        <div class="option" data-choice="b" onclick="toggleSelect(this)"><h3>方案 B</h3></div>
      </div>
    `);

    doc.querySelector<HTMLElement>('[data-choice="a"]')?.click();
    doc.querySelector<HTMLElement>('[data-choice="b"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages.filter((message) => message.type === 'visual-choice')).toEqual([]);
    expect(doc.querySelector('[data-choice="b"]')?.classList.contains('selected')).toBe(true);
    expect(doc.querySelector<HTMLButtonElement>('#visual-confirm-btn')?.disabled).toBe(false);
    expect(doc.getElementById('visual-confirm-hint')?.textContent).toBe('已选：方案 B');

    doc.querySelector<HTMLButtonElement>('#visual-confirm-btn')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages.filter((message) => message.type === 'visual-choice')).toEqual([
      { type: 'visual-choice', choice: 'b', text: '方案 B' },
    ]);

    window.removeEventListener('message', onMessage);
    iframe.remove();
  });

  it('treats options as optional: confirming with nothing selected submits an empty choice', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const onMessage = (event: MessageEvent) => {
      if (event.data && typeof event.data === 'object') messages.push(event.data);
    };
    window.addEventListener('message', onMessage);
    const { doc, iframe } = mountPreview(`
      <div class="options">
        <div class="option" data-choice="a"><h3>方案 A</h3></div>
        <div class="option" data-choice="b"><h3>方案 B</h3></div>
      </div>
    `);
    const button = doc.querySelector<HTMLButtonElement>('#visual-confirm-btn');
    expect(button?.disabled).toBe(false);

    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages.filter((m) => m.type === 'visual-choice')).toEqual([
      { type: 'visual-choice', choice: '', text: '未选择（已跳过）' },
    ]);

    window.removeEventListener('message', onMessage);
    iframe.remove();
  });

  it('offers an optional supplement that rides along with the choice, and can be skipped', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const onMessage = (event: MessageEvent) => {
      if (event.data && typeof event.data === 'object') messages.push(event.data);
    };
    window.addEventListener('message', onMessage);
    const { doc, iframe } = mountPreview(`
      <div class="options">
        <div class="option" data-choice="a"><h3>方案 A</h3></div>
      </div>
    `);
    const panel = doc.getElementById('visual-note-panel') as HTMLElement;
    const noteBtn = doc.getElementById('visual-note-btn') as HTMLButtonElement;
    expect(noteBtn.textContent).toBe('补充');
    expect(panel.hidden).toBe(true);

    noteBtn.click();
    expect(panel.hidden).toBe(false);
    const note = doc.getElementById('visual-note') as HTMLTextAreaElement;
    note.value = '  标题再大一点  ';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    expect(noteBtn.textContent).toBe('补充（已填）');

    doc.querySelector<HTMLElement>('[data-choice="a"]')?.click();
    doc.querySelector<HTMLButtonElement>('#visual-confirm-btn')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages.filter((m) => m.type === 'visual-choice')).toEqual([
      { type: 'visual-choice', choice: 'a', text: '方案 A', supplement: '标题再大一点' },
    ]);

    window.removeEventListener('message', onMessage);
    iframe.remove();
  });

  it('a group marked data-required blocks confirm until chosen and says why', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const onMessage = (event: MessageEvent) => {
      if (event.data && typeof event.data === 'object') messages.push(event.data);
    };
    window.addEventListener('message', onMessage);
    const { doc, iframe } = mountPreview(`
      <div class="options" data-required data-required-reason="需要先定方案才能继续">
        <div class="option" data-choice="a"><h3>方案 A</h3></div>
      </div>
      <div class="options">
        <div class="option" data-choice="x"><h3>额外 X</h3></div>
      </div>
    `);
    const button = doc.querySelector<HTMLButtonElement>('#visual-confirm-btn');
    expect(button?.disabled).toBe(true);
    expect(doc.getElementById('visual-confirm-hint')?.textContent).toBe('必选：需要先定方案才能继续');

    // 只选了可选组，必选组仍缺
    doc.querySelector<HTMLElement>('[data-choice="x"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(button?.disabled).toBe(true);
    button?.click();
    expect(messages.filter((m) => m.type === 'visual-choice')).toEqual([]);

    doc.querySelector<HTMLElement>('[data-choice="a"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(button?.disabled).toBe(false);

    window.removeEventListener('message', onMessage);
    iframe.remove();
  });

  it('confirms a page mockup that has no options', async () => {
    const messages: Array<{ type?: string; choice?: string; text?: string }> = [];
    const onMessage = (event: MessageEvent) => {
      if (event.data && typeof event.data === 'object') messages.push(event.data);
    };
    window.addEventListener('message', onMessage);
    const { doc, iframe } = mountPreview('<div class="mockup"><div class="mockup-body">页面</div></div>');
    const button = doc.querySelector<HTMLButtonElement>('#visual-confirm-btn');
    expect(button?.textContent).toBe('确定页面');
    expect(button?.disabled).toBe(false);

    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages.filter((message) => message.type === 'visual-choice')).toEqual([
      { type: 'visual-choice', choice: 'confirm', text: '确定页面' },
    ]);

    window.removeEventListener('message', onMessage);
    iframe.remove();
  });
});
