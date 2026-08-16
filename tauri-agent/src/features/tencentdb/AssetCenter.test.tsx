import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./tencentdbApi', () => ({
  useTencentdbConnection: () => ({ status: { state: 'ready' } }),
}));

import { AssetCenter } from './AssetCenter';

afterEach(cleanup);

describe('AssetCenter', () => {
  it('keeps the four personal asset domains visible', () => {
    render(<AssetCenter />);
    expect(screen.getByTestId('tencentdb-asset-center')).toBeTruthy();
    fireEvent.click(screen.getByText('CodeGraph'));
    expect(screen.getByText(/仓库符号/)).toBeTruthy();
  });
});
