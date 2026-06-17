import { describe, expect, it } from 'vitest';
import { fieldEffect, SETTINGS_SCHEMA, SETTING_GROUPS } from './settingsSchema';

describe('SETTINGS_SCHEMA', () => {
  it('every category has group + icon + title', () => {
    for (const c of SETTINGS_SCHEMA) {
      expect(c.group, c.id).toBeTruthy();
      expect(c.icon, c.id).toBeTruthy();
      expect(c.title, c.id).toBeTruthy();
      expect(Boolean(c.fields) || Boolean(c.sections), `${c.id} has fields or sections`).toBe(true);
    }
  });

  it('every used group is declared in SETTING_GROUPS', () => {
    const used = new Set(SETTINGS_SCHEMA.map((c) => c.group));
    for (const g of used) expect(SETTING_GROUPS).toContain(g);
  });

  it('select fields declare options', () => {
    const allFields = SETTINGS_SCHEMA.flatMap((c) => c.sections?.flatMap((s) => s.fields) ?? c.fields ?? []);
    for (const f of allFields) {
      if (f.type === 'select') expect(f.options?.length, f.key).toBeGreaterThan(0);
    }
  });

  it('memory category is split into sections', () => {
    const mem = SETTINGS_SCHEMA.find((c) => c.id === 'memory');
    expect(mem?.sections?.length).toBeGreaterThanOrEqual(2);
  });

  it('titleModel effect is instant; unmarked fields default to hot', () => {
    const allFields = SETTINGS_SCHEMA.flatMap((c) => c.sections?.flatMap((s) => s.fields) ?? c.fields ?? []);
    const titleModel = allFields.find((f) => f.key === 'titleModel');
    expect(titleModel?.effect).toBe('instant');
    expect(fieldEffect(titleModel!)).toBe('instant');
    const hotField = allFields.find((f) => f.key === 'KB_AUTO_INJECT');
    expect(fieldEffect(hotField!)).toBe('hot');
  });
});
