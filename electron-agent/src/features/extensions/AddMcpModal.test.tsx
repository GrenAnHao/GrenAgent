import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@lobehub/ui';
import { AddMcpModal } from './AddMcpModal';


afterEach(cleanup);

const renderModal = (props: Partial<Parameters<typeof AddMcpModal>[0]> = {}) =>
  render(
    <ThemeProvider>
      <AddMcpModal
        open
        existingNames={[]}
        onSubmitForm={props.onSubmitForm ?? vi.fn()}
        onSubmitImport={props.onSubmitImport ?? vi.fn()}
        onClose={props.onClose ?? vi.fn()}
        editing={props.editing}
      />
    </ThemeProvider>,
  );

describe('AddMcpModal', () => {
  it('submits a STDIO form config', () => {
    const onSubmitForm = vi.fn();
    renderModal({ onSubmitForm });
    fireEvent.change(screen.getByTestId('mcp-name'), { target: { value: 'gh' } });
    fireEvent.change(screen.getByTestId('mcp-command'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByTestId('mcp-submit'));
    expect(onSubmitForm).toHaveBeenCalledWith({ name: 'gh', config: { command: 'npx' } }, true);
  });

  it('shows validation error for empty name', () => {
    const onSubmitForm = vi.fn();
    renderModal({ onSubmitForm });
    fireEvent.click(screen.getByTestId('mcp-submit'));
    expect(onSubmitForm).not.toHaveBeenCalled();
    expect(screen.getByText(/名称不能为空/)).toBeTruthy();
  });

  it('switches to REMOTE and submits url + bearer', () => {
    const onSubmitForm = vi.fn();
    renderModal({ onSubmitForm });
    fireEvent.click(screen.getByTestId('mcp-type-remote'));
    fireEvent.change(screen.getByTestId('mcp-name'), { target: { value: 'r' } });
    fireEvent.change(screen.getByTestId('mcp-url'), { target: { value: 'https://x.com' } });
    fireEvent.click(screen.getByTestId('mcp-auth-bearer'));
    fireEvent.change(screen.getByTestId('mcp-token'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('mcp-submit'));
    expect(onSubmitForm).toHaveBeenCalledWith(
      { name: 'r', config: { url: 'https://x.com', headers: { Authorization: 'Bearer abc' } } },
      true,
    );
  });

  it('keeps masked credentials, spaced argv and extra fields across both modes and surfaces invalid JSON', async () => {
    const submit = vi.fn();
    const config = { command:'node',args:['C:/My Files/app.js',''],env:{API_TOKEN:'fixture-secret'},exposure:'direct',headers:{} };
    renderModal({editing:{name:'demo',config,enabled:false,scope:'project'}, onSubmitForm:submit});
    expect(screen.getByTestId('mcp-env-val-0')).toHaveAttribute('type','password');
    fireEvent.click(screen.getByTestId('mcp-tab-json'));
    const json=screen.getByTestId('mcp-json') as HTMLTextAreaElement;
    expect(json.readOnly).toBe(true); expect(json.value).not.toContain('fixture-secret');
    fireEvent.click(screen.getByText('显示凭据并编辑 JSON'));
    expect(JSON.parse(json.value).mcpServers.demo).toEqual(config);
    fireEvent.change(json,{target:{value:'{'}});
    fireEvent.click(screen.getByTestId('mcp-tab-config'));
    expect(screen.getByText('JSON 解析失败')).toBeInTheDocument();
    fireEvent.change(json,{target:{value:JSON.stringify({...config, command:'node2'})}});
    fireEvent.click(screen.getByTestId('mcp-tab-config'));
    expect(screen.getByTestId('mcp-command')).toHaveValue('node2');
    fireEvent.change(screen.getByRole('combobox'),{target:{value:'global'}});
    fireEvent.click(screen.getByTestId('mcp-submit'));
    await waitFor(()=>expect(submit).toHaveBeenCalledWith({name:'demo',config:{...config,command:'node2'}},false,'global'));
  });

  it('imports JSON with multiple servers', () => {
    const onSubmitImport = vi.fn();
    renderModal({ onSubmitImport });
    fireEvent.click(screen.getByTestId('mcp-tab-json'));
    fireEvent.change(screen.getByTestId('mcp-json'), {
      target: { value: '{"mcpServers":{"a":{"command":"npx"},"b":{"url":"https://y"}}}' },
    });
    fireEvent.click(screen.getByTestId('mcp-import'));
    expect(onSubmitImport).toHaveBeenCalledWith([
      { name: 'a', config: { command: 'npx' } },
      { name: 'b', config: { url: 'https://y' } },
    ]);
  });
});
