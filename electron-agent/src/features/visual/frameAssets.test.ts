import { describe, expect, it } from 'vitest';
import { buildSrcDoc, PREVIEW_HELPER_JS } from './frameAssets';

function runPreviewHelper(frame: Window) {
  (frame as Window & Pick<typeof globalThis, 'eval'>).eval(PREVIEW_HELPER_JS);
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

  it('lets the preview grow past the viewport without a fixed confirm bar', () => {
    const doc = buildSrcDoc('<div class="split"></div>', { fill: true });
    expect(doc).toContain('html { height: 100% !important; }');
    expect(doc).toContain('body { height: auto !important; min-height: 100% !important;');
    expect(doc).not.toMatch(/html, body \{ height: 100% !important/);
  });

  it('does not inject a feedback bar into a filled panel', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error('iframe unavailable');
    doc.open();
    doc.write(buildSrcDoc('<div class="split"><div class="mockup">A</div></div>', { fill: true }));
    doc.close();
    runPreviewHelper(win);
    expect(doc.getElementById('visual-confirm-bar')).toBeNull();
    expect(doc.getElementById('visual-note-panel')).toBeNull();

    iframe.remove();
  });

  it('does not paint a stylesheet as page text when the panel fills', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error('iframe unavailable');
    doc.open();
    doc.write(buildSrcDoc('<div class="split"><div class="mockup">A</div></div>', { fill: true }));
    doc.close();
    runPreviewHelper(win);
    expect(doc.getElementById('visual-confirm-style')).toBeNull();
    expect(doc.body.textContent).not.toContain('visual-confirm-bar');

    iframe.remove();
  });

  it('patches full documents so extra options wrap', () => {
    const doc = buildSrcDoc('<!DOCTYPE html><html><head></head><body><div class="split"></div></body></html>');
    expect(doc).toContain('data-visual-layout');
    expect(doc).toContain('repeat(auto-fit, minmax(min(100%, 420px), 1fr))');
    expect(doc).not.toContain('height: 100% !important');
    expect(doc).not.toContain('visual-choice');
    expect(doc).not.toContain('确认提交');
  });
});

describe('preview-only helper', () => {
  it('keeps option switching and never emits visual-choice or a feedback UI', async () => {
    const messages: Array<{ type?: string }> = [];
    const onMessage = (event: MessageEvent) => { if (event.data && typeof event.data === 'object') messages.push(event.data); };
    window.addEventListener('message', onMessage);
    const live = document.createElement('iframe');
    document.body.appendChild(live);
    const preview = live.contentDocument!;
    preview.open(); preview.write(buildSrcDoc('<div class="options"><div class="option" data-choice="a">A</div><div class="option" data-choice="b">B</div></div>')); preview.close();
    runPreviewHelper(live.contentWindow!);
    preview.querySelector<HTMLElement>('[data-choice="a"]')?.click();
    preview.querySelector<HTMLElement>('[data-choice="b"]')?.click();
    expect(preview.querySelector('[data-choice="b"]')?.classList.contains('selected')).toBe(true);
    expect(preview.getElementById('visual-confirm-bar')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages.filter((m) => m.type === 'visual-choice')).toEqual([]);
    live.remove(); window.removeEventListener('message', onMessage);
  });
});
