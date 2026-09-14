import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./providerModelData', () => ({
  useProviderModelData: () => ({
    ready: true,
    providerOptions: [{ label: 'A', value: 'a' }],
    nameOf: (id: string) => id.toUpperCase(),
    modelsFor: (p: string) => (p === 'a' ? [{ label: 'b', value: 'b' }, { label: 'c', value: 'c' }] : []),
  }),
}));

import { ModelListField, parseModelList } from './ModelListField';

afterEach(cleanup);

describe('parseModelList', () => {
  it('parses a JSON array and drops junk', () => {
    expect(parseModelList('["a/b", 1, " c/d "]')).toEqual(['a/b', 'c/d']);
    expect(parseModelList('nope')).toEqual([]);
    expect(parseModelList('')).toEqual([]);
  });
});

describe('ModelListField', () => {
  it('renders stored routes as tags, marking ones missing from the catalog', () => {
    render(<ModelListField value='["a/b","z/z"]' testId="f" onChange={() => {}} />);
    expect(screen.getByText('A / b')).toBeTruthy();
    expect(screen.getByText('z/z（不可用）')).toBeTruthy();
  });

  it('removing a tag writes the remaining list as JSON', () => {
    const onChange = vi.fn();
    render(<ModelListField value='["a/b","z/z"]' testId="f" onChange={onChange} />);
    const removes = screen.getAllByLabelText('close');
    fireEvent.click(removes[1]);
    expect(onChange).toHaveBeenCalledWith('["a/b"]');
  });
});
