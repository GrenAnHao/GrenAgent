import { describe, it, expect } from 'vitest';
import {
  CircleHelp,
  Cpu,
  FoldVertical,
  MessageSquarePlus,
  MessageSquareText,
  Rocket,
  Sparkles,
  SquareTerminal,
  Wand2,
  Wrench,
} from 'lucide-react';
import { CATEGORY_ICON, resolveCommandIcon } from './commandIcons';
import type { PiCommand } from './commandTypes';

const builtin = (name: string): PiCommand => ({ name, source: 'api', apiSource: 'builtin' });
const extension = (name: string): PiCommand => ({ name, source: 'api', apiSource: 'extension' });

describe('resolveCommandIcon', () => {
  it('gives system (builtin) commands function-matching icons', () => {
    expect(resolveCommandIcon(builtin('init'))).toBe(Rocket);
    expect(resolveCommandIcon(builtin('compact'))).toBe(FoldVertical);
    expect(resolveCommandIcon(builtin('model'))).toBe(Cpu);
    expect(resolveCommandIcon(builtin('help'))).toBe(CircleHelp);
  });

  it('falls back to the builtin category icon for unknown system commands', () => {
    expect(resolveCommandIcon(builtin('totally-unknown-cmd'))).toBe(SquareTerminal);
  });

  it('matches command names case-insensitively', () => {
    expect(resolveCommandIcon(builtin('COMPACT'))).toBe(FoldVertical);
  });

  it('resolves frontend quick actions by name before category fallback', () => {
    expect(resolveCommandIcon({ name: 'compact', source: 'frontend' })).toBe(FoldVertical);
    expect(resolveCommandIcon({ name: 'newSession', source: 'frontend' })).toBe(MessageSquarePlus);
  });

  it('keeps one recognizable category icon for every skill command', () => {
    expect(resolveCommandIcon({ name: 'skill:caveman', source: 'api', apiSource: 'skill' })).toBe(
      Sparkles,
    );
    expect(resolveCommandIcon({ name: 'skill:anything', source: 'api', apiSource: 'skill' })).toBe(
      Sparkles,
    );
  });

  it('keeps one recognizable tool icon for every extension command', () => {
    expect(resolveCommandIcon(extension('checkpoint'))).toBe(Wrench);
    expect(resolveCommandIcon(extension('memory'))).toBe(Wrench);
    expect(resolveCommandIcon(extension('any-tool'))).toBe(Wrench);
  });

  it('uses the prompt category icon for prompt commands', () => {
    expect(resolveCommandIcon({ name: 'my-prompt', source: 'api', apiSource: 'prompt' })).toBe(
      MessageSquareText,
    );
  });

  it('uses the unknown category icon as the final fallback', () => {
    expect(resolveCommandIcon({ name: 'mystery', source: 'api' })).toBe(Wand2);
    expect(CATEGORY_ICON.unknown).toBe(Wand2);
  });
});
