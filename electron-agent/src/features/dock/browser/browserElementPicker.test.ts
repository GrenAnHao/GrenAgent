import { describe, expect, it } from 'vitest';
import {
  bindBrowserElementChatSink,
  buildBrowserElementPickerScript,
  buildCancelBrowserElementPickerScript,
  formatBrowserElementOffer,
  offerBrowserElementToChat,
  parseBrowserElementPick,
} from './browserElementPicker';

describe('browserElementPicker', () => {
  it('formats a selected element as tab-bound context, not a fake html file', () => {
    const offer = formatBrowserElementOffer({
      status: 'selected',
      element: {
        tagName: 'button',
        selector: 'button#go',
        pageUrl: 'https://example.com/app',
        pageTitle: '示例',
        text: '提交',
        html: '<button id="go">提交</button>',
        background: '#000000',
        color: '#FFFFFF',
        font: '500 14px/20px sans-serif',
        width: 80,
        height: 32,
        margin: '0px',
        padding: '8px',
        role: 'button',
        accessibleName: '提交',
        keyboardFocusable: true,
      },
    }, { tabId: 'browser-9', tabTitle: '示例页' });
    expect(offer.title).toBe('button#go');
    expect(offer.title).not.toContain('.html');
    expect(offer.text).toContain('标签页 id: browser-9');
    expect(offer.text).toContain('标签页: 示例页');
    expect(offer.text).toContain('定位: tab=browser-9 selector=button#go');
    expect(offer.text).toContain('提交');
  });

  it('accepts cancelled and selected payloads and rejects junk', () => {
    expect(parseBrowserElementPick({ status: 'cancelled' })).toEqual({ status: 'cancelled' });
    expect(parseBrowserElementPick({ status: 'selected', element: { tagName: 'div', selector: 'div' } })).toMatchObject({
      status: 'selected',
    });
    expect(parseBrowserElementPick({ status: 'selected' })).toBeNull();
    expect(parseBrowserElementPick(null)).toBeNull();
  });

  it('delivers offers to the bound chat sink', () => {
    const received: Array<{ title: string; text: string }> = [];
    bindBrowserElementChatSink((offer) => received.push(offer));
    offerBrowserElementToChat({ title: 'a.html', text: 'hello' });
    bindBrowserElementChatSink(null);
    offerBrowserElementToChat({ title: 'b.html', text: 'ignored' });
    expect(received).toEqual([{ title: 'a.html', text: 'hello' }]);
  });

  it('builds a cancel script that calls the guest picker handle', () => {
    expect(buildCancelBrowserElementPickerScript()).toContain('__grenBrowserElementPicker');
  });

  it('serializes a self-contained guest picker without host closures', () => {
    const script = buildBrowserElementPickerScript();
    expect(script).toContain('__grenBrowserElementPicker');
    expect(script).toContain('data-gren-element-picker');
    expect(script).toContain('stopImmediatePropagation');
    expect(script).toContain('ACCESSIBILITY');
    expect(script).not.toContain('PICKER_KEY');
    expect(script).not.toMatch(/addEventListener\('pointerdown',\s*onPick/);
  });
});
