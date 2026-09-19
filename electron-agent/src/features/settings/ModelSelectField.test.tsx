import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { providerModel } = vi.hoisted(() => ({
  providerModel: {
    ready: true,
    providerOptions: [{ label: 'A', value: 'a' }],
    nameOf: (id: string) => id,
    modelsFor: (p: string) => (p === 'a' ? [{ label: 'b', value: 'b' }] : []),
  },
}));

vi.mock('./providerModelData', () => ({
  useProviderModelData: () => providerModel,
}));

import {
  MODEL_SELECT_MODEL_WIDTH,
  MODEL_SELECT_PROVIDER_WIDTH,
  MODEL_SELECT_ROW_WIDTH,
  ModelSelectField,
} from './ModelSelectField';

afterEach(() => {
  providerModel.ready = true;
  cleanup();
});

describe('ModelSelectField', () => {
  it('locks provider and model selects so different placeholders stay the same width', () => {
    const { rerender } = render(
      <ModelSelectField value="" placeholder="如 anthropic/claude-sonnet" testId="m" onChange={() => {}} />,
    );
    const provider = screen.getByTestId('m-provider');
    const model = screen.getByTestId('m');
    expect(provider).toHaveStyle({ width: `${MODEL_SELECT_PROVIDER_WIDTH}px` });
    expect(model).toHaveStyle({ width: `${MODEL_SELECT_MODEL_WIDTH}px` });

    rerender(
      <ModelSelectField value="" placeholder="如 anthropic/claude-haiku" testId="m" onChange={() => {}} />,
    );
    expect(screen.getByTestId('m-provider')).toHaveStyle({ width: `${MODEL_SELECT_PROVIDER_WIDTH}px` });
    expect(screen.getByTestId('m')).toHaveStyle({ width: `${MODEL_SELECT_MODEL_WIDTH}px` });
  });

  it('fallback input uses the same row width when the catalog is empty', () => {
    providerModel.ready = false;
    render(<ModelSelectField value="" placeholder="如 anthropic/claude-sonnet" testId="m" onChange={() => {}} />);
    expect(screen.getByTestId('m')).toHaveStyle({ width: `${MODEL_SELECT_ROW_WIDTH}px` });
  });
});
