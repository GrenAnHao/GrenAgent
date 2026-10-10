import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DevinAccountCard } from './DevinAccountCard';
import { pi } from '../../lib/pi';

vi.mock('../../lib/pi', () => ({
  pi: {
    devinAccountStatus: vi.fn(),
    devinAccountLogin: vi.fn(),
    devinAccountLogout: vi.fn(),
  },
}));

describe('DevinAccountCard', () => {
  beforeEach(() => {
    vi.mocked(pi.devinAccountStatus).mockReset();
    vi.mocked(pi.devinAccountLogin).mockReset();
    vi.mocked(pi.devinAccountLogout).mockReset();
  });

  it('shows expiry and does not render a token', async () => {
    vi.mocked(pi.devinAccountStatus).mockResolvedValue({
      state: 'ok',
      expiresAt: '2026-10-06T00:00:00.000Z',
      expirySource: 'fallback',
      ...({ token: 'secret-token' } as object),
    } as never);
    render(<DevinAccountCard />);
    expect(await screen.findByTestId('devin-account-status')).toHaveTextContent('已登录，到期 2026-10-06T00:00:00.000Z');
    expect(document.body.textContent).not.toContain('secret-token');
  });

  it('login and logout call the account commands', async () => {
    vi.mocked(pi.devinAccountStatus).mockResolvedValue({ state: 'missing' });
    let finishLogin: (view: { state: 'ok'; expiresAt: string }) => void = () => {};
    vi.mocked(pi.devinAccountLogin).mockImplementation(() => new Promise((resolve) => { finishLogin = resolve; }));
    vi.mocked(pi.devinAccountLogout).mockResolvedValue({ state: 'missing' });
    render(<DevinAccountCard />);
    expect(await screen.findByTestId('devin-account-status')).toHaveTextContent('未登录');
    expect(screen.getByTestId('devin-account-login').textContent).toBe('OAuth 登录');

    fireEvent.click(screen.getByTestId('devin-account-login'));
    expect(screen.getByTestId('devin-account-status').textContent).toContain('正在等待 Devin OAuth 授权');
    finishLogin({ state: 'ok', expiresAt: '2026-10-06T00:00:00.000Z' });
    await waitFor(() => expect(pi.devinAccountLogin).toHaveBeenCalled());
    expect(await screen.findByTestId('devin-account-status')).toHaveTextContent('已登录');

    fireEvent.click(screen.getByTestId('devin-account-logout'));
    await waitFor(() => expect(pi.devinAccountLogout).toHaveBeenCalled());
    expect(await screen.findByTestId('devin-account-status')).toHaveTextContent('未登录');
  });
});
