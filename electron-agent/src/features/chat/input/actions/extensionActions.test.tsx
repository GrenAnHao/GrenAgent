import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ChatInputProvider, type ChatInputContextValue } from '../ChatInputContext';
import { actionMap, DEFAULT_LEFT_ACTIONS } from '../config';
import GenerateImageAction from './GenerateImageAction';
import SpeakAction from './SpeakAction';

afterEach(() => {
  cleanup();
});

function renderWithCtx(ui: ReactNode) {
  const setValue = vi.fn();
  const ctx: ChatInputContextValue = {
    editor: {} as ChatInputContextValue['editor'],
    empty: true,
    setEmpty: vi.fn(),
    setValue,
    attachments: [],
    addAttachments: vi.fn(),
    removeAttachment: vi.fn(),
    pastedTexts: [],
    addPastedText: vi.fn(),
    removePastedText: vi.fn(),
    isStreaming: false,
    isGenerating: false,
    hasRunningTool: false,
    inFlight: false,
    steering: [],
    followUp: [],
    steerQueued: vi.fn(),
    hasComposerQueue: false,
    send: vi.fn(),
    stop: vi.fn(),
    readDraft: () => '',
  };
  render(<ChatInputProvider value={ctx}>{ui}</ChatInputProvider>);
  return setValue;
}

describe('input extension actions', () => {
  it('does not register the retired knowledge action', () => {
    expect('kbAdd' in actionMap).toBe(false);
    expect(DEFAULT_LEFT_ACTIONS).not.toContain('kbAdd');
  });

  it('GenerateImageAction prefills an image instruction', () => {
    const setValue = renderWithCtx(<GenerateImageAction />);
    fireEvent.click(screen.getByRole('button'));
    expect(setValue.mock.calls[0][0]).toContain('图片');
  });

  it('SpeakAction prefills a speak instruction', () => {
    const setValue = renderWithCtx(<SpeakAction />);
    fireEvent.click(screen.getByRole('button'));
    expect(setValue.mock.calls[0][0]).toContain('朗读');
  });
});
