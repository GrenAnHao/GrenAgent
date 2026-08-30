import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagerLayout } from './ManagerLayout';

afterEach(() => {
  cleanup();
});

describe('ManagerLayout', () => {
  it('renders header, list and detail slots', () => {
    render(
      <ManagerLayout
        header={<div>HEADER</div>}
        list={<div>LIST</div>}
        detail={<div>DETAIL</div>}
      />,
    );
    expect(screen.getByText('HEADER')).toBeTruthy();
    expect(screen.getByText('LIST')).toBeTruthy();
    expect(screen.getByText('DETAIL')).toBeTruthy();
  });

  it('uses the provided testId on the root', () => {
    render(<ManagerLayout testId="knowledge-panel" header={null} list={null} detail={null} />);
    expect(screen.getByTestId('knowledge-panel')).toBeTruthy();
  });
});
