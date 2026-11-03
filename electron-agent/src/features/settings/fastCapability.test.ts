import { describe, expect, it } from 'vitest';
import { loadState, serializeState } from './providerConfigAdapter';

// 抓住 Fast 被 compat 过滤器丢弃、或重新加载后被错误开启的回归。
describe('Fast capability configuration', () => {
  for (const api of ['anthropic-messages', 'openai-completions', 'openai-responses']) {
    it(`${api}: explicit Fast survives save/reload; missing stays off`, () => {
      const raw = JSON.stringify({ providers: { relay: { api, models: [
        { id: 'on', compat: { supportsFastMode: true } },
        { id: 'off', compat: { supportsFastMode: false } },
        { id: 'missing' },
      ] } } });
      const state = loadState(raw, '{}', []);
      expect(state[0].models.map((m) => (m as { fast?: boolean }).fast === true)).toEqual([true, false, false]);
      const saved = serializeState(state);
      const rows = JSON.parse(saved.modelsJson).providers.relay.models;
      expect(rows[0].compat.supportsFastMode).toBe(true);
      expect(rows[1].compat?.supportsFastMode === true).toBe(false);
      expect(rows[2].compat?.supportsFastMode === true).toBe(false);
      expect(loadState(saved.modelsJson, saved.authJson, [])[0].models.map((m) => (m as { fast?: boolean }).fast === true)).toEqual([true, false, false]);
    });
  }
});
