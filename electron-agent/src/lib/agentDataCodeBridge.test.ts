import { afterEach, expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() }, dialog: { showOpenDialog: vi.fn() }, shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() } }));
vi.mock('electron', () => electron);
import { registerIpcHandlers, type IpcServices } from '../../electron/ipc/register';
import { IPC_CHANNELS } from '../../electron/ipc/contracts';
import { agentDataApi, type CodeRetrievalRequest } from './agentData';

const workspace = 'D:/proj/alpha';
const cases: CodeRetrievalRequest[] = [
  { workspace, tool: 'codegraph_search', args: { query: 'parse', limit: 5 } },
  { workspace, tool: 'codegraph_explore', args: { query: 'parse', maxFiles: 3 } },
  { workspace, tool: 'codegraph_callers', args: { symbol: 'parse', file: 'src/a.ts' } },
  { workspace, tool: 'codegraph_callees', args: { symbol: 'parse', file: 'src/a.ts' } },
  { workspace, tool: 'codegraph_impact', args: { symbol: 'parse', depth: 2 } },
  { workspace, tool: 'codegraph_node', args: { file: 'src/a.ts', line: 3, includeCode: true } },
  { workspace, tool: 'codegraph_files', args: { path: 'src', format: 'flat', includeMetadata: true } },
];
afterEach(() => { vi.unstubAllGlobals(); electron.ipcMain.handle.mockReset(); });
it.each(cases)('preserves $tool arguments and opaque MCP responses across the registered bridge', async (input) => {
  const raw = { content: [{ type: 'text', text: 'opaque result' }], structuredContent: { opaque: [input.tool] }, isError: input.tool === 'codegraph_impact' };
  const request = vi.fn(async () => raw);
  registerIpcHandlers({ agentData: { request } } as unknown as IpcServices);
  vi.stubGlobal('window', { gren: { invoke: async (command: string, args: Record<string, unknown>) => {
    const entry = electron.ipcMain.handle.mock.calls.find(([channel]) => channel === IPC_CHANNELS.invoke);
    if (!entry) throw new Error('missing invoke handler');
    return entry[1]({}, { command, args });
  } } });
  expect(agentDataApi.code).toHaveProperty('call', expect.any(Function));
  await expect(agentDataApi.code.call(input)).resolves.toEqual(raw);
  expect(request).toHaveBeenCalledWith('codeRetrieval.call', input);
});
