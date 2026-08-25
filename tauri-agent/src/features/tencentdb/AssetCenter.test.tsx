import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { connection, coreRequest, listKnowledgeAssets, provisionWorkspaceAssets, reloadSkills, syncCodeGraph, syncWiki } = vi.hoisted(() => ({
  connection: {
    config: { agentId: 'agent-current' },
    status: { state: 'ready', mode: 'local', knowledgeEndpoint: 'http://k/v3' },
  },
  coreRequest: vi.fn(),
  listKnowledgeAssets: vi.fn(() => Promise.resolve({ codeGraphs: [], wikis: [] })),
  provisionWorkspaceAssets: vi.fn(() => Promise.resolve({ codeGraphId: 'cg-1', wikiId: 'wiki-1' })),
  reloadSkills: vi.fn(() => Promise.resolve()),
  syncCodeGraph: vi.fn(() => Promise.resolve({})),
  syncWiki: vi.fn(() => Promise.resolve({})),
}));

vi.mock('./tencentdbApi', () => ({
  tencentdbApi: { coreRequest, listKnowledgeAssets, provisionWorkspaceAssets, reloadSkills, syncCodeGraph, syncWiki },
  useTencentdbConnection: () => connection,
}));
vi.mock('../../store', () => ({
  useSessionStore: (selector: (state: { activeWorkspace: string }) => unknown) => selector({ activeWorkspace: '/workspace/app' }),
}));

import { AssetCenter } from './AssetCenter';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  connection.status = { state: 'ready', mode: 'local', knowledgeEndpoint: 'http://k/v3' };
  coreRequest.mockImplementation((route: string) => {
    if (route === '/v3/conversation/query') {
      return Promise.resolve({ messages: [{ id: 'message-1', role: 'user', content: '记住深色主题' }], total: 1 });
    }
    if (route === '/v3/atomic/query') return Promise.resolve({ items: [], total: 0 });
    if (route === '/v3/scenario/ls') return Promise.resolve({ entries: [], total: 0 });
    if (route === '/v3/core/read') return Promise.resolve({ content: null, created_at: null, updated_at: null });
    if (route === '/v3/skill/list') return Promise.resolve({ items: [], total: 0 });
    return Promise.resolve({});
  });
});

describe('AssetCenter', () => {
  it('keeps the four personal asset domains visible', () => {
    render(<AssetCenter />);
    expect(screen.getByTestId('tencentdb-asset-center')).toBeTruthy();
    fireEvent.click(screen.getByText('CodeGraph'));
    expect(screen.getByText(/仓库符号/)).toBeTruthy();
  });

  it('provisions the active workspace through TencentDB', async () => {
    render(<AssetCenter />);
    fireEvent.click(screen.getByText('CodeGraph'));
    await screen.findByText('暂无 TencentDB 资产');
    fireEvent.click(await screen.findByRole('button', { name: /初始化当前工作区/ }));
    await waitFor(() => expect(provisionWorkspaceAssets).toHaveBeenCalledWith('/workspace/app'));
  });

  it('loads, searches and deletes Chat Memory with layer-specific Core routes', async () => {
    render(<AssetCenter />);

    expect(await screen.findByText('记住深色主题')).toBeTruthy();
    expect(coreRequest).toHaveBeenCalledWith('/v3/conversation/query', { limit: 100, offset: 0 });

    fireEvent.change(screen.getByPlaceholderText('搜索当前层级'), { target: { value: '深色' } });
    coreRequest.mockResolvedValueOnce({ messages: [{ id: 'message-1', role: 'user', content: '记住深色主题' }] });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith('/v3/conversation/search', { query: '深色', limit: 100 }));

    fireEvent.click(screen.getByRole('button', { name: '删除 记住深色主题' }));
    fireEvent.click(await screen.findByRole('button', { name: '确定' }));
    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith('/v3/conversation/delete', { message_ids: ['message-1'] }));
  });

  it('ignores an older Chat Memory response after switching levels', async () => {
    const pendingL0 = deferred<{ messages: Array<{ id: string; role: string; content: string }> }>();
    coreRequest.mockImplementation((route: string) => {
      if (route === '/v3/conversation/query') return pendingL0.promise;
      if (route === '/v3/atomic/query') {
        return Promise.resolve({ items: [{ id: 'atomic-current', type: 'preference', content: '当前 L1 记忆' }] });
      }
      return Promise.resolve({});
    });

    render(<AssetCenter />);
    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith('/v3/conversation/query', { limit: 100, offset: 0 }));
    fireEvent.click(screen.getByText('L1 原子记忆'));
    expect(await screen.findByText('当前 L1 记忆')).toBeTruthy();

    await act(async () => {
      pendingL0.resolve({ messages: [{ id: 'conversation-stale', role: 'user', content: '旧 L0 对话' }] });
      await pendingL0.promise;
    });

    expect(screen.queryByText('旧 L0 对话')).toBeNull();
    expect(screen.getByText('当前 L1 记忆')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '删除 旧 L0 对话' })).toBeNull();
  });

  it('filters L2 locally and clears a chat-memory asset from the second fixed-asset page', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      asset_id: `skill-${index}`,
      asset_type: 'skill',
      name: `Skill ${index}`,
    }));
    coreRequest.mockImplementation((route: string, body?: { offset?: number }) => {
      if (route === '/v3/conversation/query') return Promise.resolve({ messages: [], total: 0 });
      if (route === '/v3/scenario/ls') {
        return Promise.resolve({ entries: [
          { path: 'work/release.md', summary: '发布流程', created_at: '', updated_at: '' },
          { path: 'life/travel.md', summary: '旅行偏好', created_at: '', updated_at: '' },
        ], total: 2 });
      }
      if (route === '/v3/meta/agent-fixed-asset/list-with-detail') return Promise.resolve({
        items: body?.offset === 100
          ? [{ asset_id: 'memory-current', asset_type: 'chat_memory', name: 'Memory' }]
          : firstPage,
        total: 101,
      });
      if (route === '/v3/chat-memory/clear') return Promise.resolve({
        all_cleared: true,
        items: [{ memory_id: 'memory-current', cleared: true }],
      });
      return Promise.resolve({});
    });
    render(<AssetCenter />);
    fireEvent.click(screen.getByText('L2 场景'));
    expect(await screen.findByText('work/release.md')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('搜索当前层级'), { target: { value: '旅行' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    expect(screen.queryByText('work/release.md')).toBeNull();
    expect(screen.getByText('life/travel.md')).toBeTruthy();
    expect(coreRequest).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: '清空整个空间' }));
    fireEvent.click(await screen.findByRole('button', { name: '确定' }));
    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith(
      '/v3/meta/agent-fixed-asset/list-with-detail',
      { limit: 100, offset: 100 },
    ));
    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith('/v3/chat-memory/clear', { memory_ids: ['memory-current'] }));
  });

  it('reports a partial Chat Memory clear failure', async () => {
    coreRequest.mockImplementation((route: string) => {
      if (route === '/v3/conversation/query') return Promise.resolve({ messages: [], total: 0 });
      if (route === '/v3/meta/agent-fixed-asset/list-with-detail') return Promise.resolve({
        items: [{ asset_id: 'memory-current', asset_type: 'chat_memory' }],
      });
      if (route === '/v3/chat-memory/clear') return Promise.resolve({
        all_cleared: false,
        items: [{ memory_id: 'memory-current', cleared: false, reason: 'storage unavailable' }],
      });
      return Promise.resolve({});
    });
    render(<AssetCenter />);
    fireEvent.click(screen.getByRole('button', { name: '清空整个空间' }));
    fireEvent.click(await screen.findByRole('button', { name: '确定' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('storage unavailable');
  });

  it('rejects multiple Chat Memory bindings split across fixed-asset pages', async () => {
    const firstPage = [
      { asset_id: 'memory-a', asset_type: 'chat_memory', name: 'Memory A' },
      ...Array.from({ length: 99 }, (_, index) => ({
        asset_id: `skill-${index}`,
        asset_type: 'skill',
        name: `Skill ${index}`,
      })),
    ];
    coreRequest.mockImplementation((route: string, body?: { offset?: number }) => {
      if (route === '/v3/conversation/query') return Promise.resolve({ messages: [], total: 0 });
      if (route === '/v3/meta/agent-fixed-asset/list-with-detail') return Promise.resolve({
        items: body?.offset === 100
          ? [{ asset_id: 'memory-b', asset_type: 'chat_memory', name: 'Memory B' }]
          : firstPage,
        total: 101,
      });
      if (route === '/v3/chat-memory/clear') return Promise.resolve({
        all_cleared: true,
        items: [{ memory_id: 'memory-a', cleared: true }],
      });
      return Promise.resolve({});
    });

    render(<AssetCenter />);
    fireEvent.click(screen.getByRole('button', { name: '清空整个空间' }));
    fireEvent.click(await screen.findByRole('button', { name: '确定' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('当前 Agent 存在多个 Chat Memory 资产');
    expect(coreRequest.mock.calls.some(([route]) => route === '/v3/chat-memory/clear')).toBe(false);
  });

  it('deletes L1 and L3 records and treats blank L3 content as empty', async () => {
    coreRequest.mockImplementation((route: string) => {
      if (route === '/v3/conversation/query') return Promise.resolve({ messages: [] });
      if (route === '/v3/atomic/query') return Promise.resolve({ items: [{ id: 'atomic-1', type: 'preference', content: '偏好简洁' }] });
      if (route === '/v3/core/read') return Promise.resolve({ content: '   ', updated_at: null });
      return Promise.resolve({});
    });
    render(<AssetCenter />);
    fireEvent.click(screen.getByText('L1 原子记忆'));
    fireEvent.click(await screen.findByRole('button', { name: '删除 偏好简洁' }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith('/v3/atomic/delete', { ids: ['atomic-1'] }));

    fireEvent.click(screen.getByText('L3 核心画像'));
    expect(await screen.findByText('当前层级暂无记忆')).toBeTruthy();
    expect(screen.queryByText('个人核心画像')).toBeNull();
  });

  it('creates a complete matching SKILL.md and hot reloads managed skills', async () => {
    render(<AssetCenter />);
    fireEvent.click(screen.getByText('Skills'));
    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith('/v3/skill/list', {
      filters: { status: ['active'] },
      pagination: { limit: 100, offset: 0 },
    }));

    fireEvent.click(screen.getByRole('button', { name: '新建 Skill' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: 'release-helper' } });
    fireEvent.change(within(dialog).getByLabelText('描述'), { target: { value: '检查发布: 流程' } });
    fireEvent.change(within(dialog).getByLabelText('正文'), { target: { value: '## Steps\n\nRun tests.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));

    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith('/v3/skill/create', {
      name: 'release-helper',
      content: '---\nname: release-helper\ndescription: "检查发布: 流程"\n---\n\n# release-helper\n\n## Steps\n\nRun tests.\n',
    }));
    expect(reloadSkills).toHaveBeenCalledTimes(1);
  });

  it('loads Skill details, updates by expected version and manages manifest resources', async () => {
    coreRequest.mockImplementation((route: string) => {
      if (route === '/v3/conversation/query') return Promise.resolve({ messages: [], total: 0 });
      if (route === '/v3/skill/list') return Promise.resolve({ items: [{ skill_id: 'review', name: 'review', description: 'Review code', version: 3, status: 'active' }], total: 1 });
      if (route === '/v3/skill/get') return Promise.resolve({ skill_id: 'review', name: 'review', description: 'Review code', version: 3, status: 'active', content: '# Review', manifest: [{ path: 'refs/checklist.md', size_bytes: 4, mime_type: 'text/markdown', is_executable: false }] });
      if (route === '/v3/skill/versions') return Promise.resolve({ items: [{ skill_id: 'review', version: 3, updated_at_ms: 10 }], total: 1 });
      if (route === '/v3/skill/files/read') return Promise.resolve({ path: 'refs/checklist.md', content: 'old', encoding: 'utf-8', size_bytes: 3, mime_type: 'text/markdown', version: 3 });
      return Promise.resolve({});
    });
    render(<AssetCenter />);
    fireEvent.click(screen.getByText('Skills'));
    fireEvent.click(await screen.findByRole('button', { name: '查看 review' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('v3')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '读取 refs/checklist.md' }));
    expect(await within(dialog).findByDisplayValue('old')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('资源内容'), { target: { value: 'new' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存资源' }));
    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith('/v3/skill/files/write', {
      skill_id: 'review', expected_version: 3,
      files: [{ path: 'refs/checklist.md', content: 'new', encoding: 'utf-8' }],
    }));

    await waitFor(() => expect(coreRequest.mock.calls.filter(([route]) => route === '/v3/skill/get')).toHaveLength(2));
    fireEvent.change(within(dialog).getByLabelText('SKILL.md'), { target: { value: '# Updated' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存正文' }));
    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith('/v3/skill/update', {
      skill_id: 'review', expected_version: 3, content: '# Updated',
    }));

    fireEvent.click(within(dialog).getByRole('button', { name: '删除资源 refs/checklist.md' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '确定' }));
    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith('/v3/skill/files/remove', {
      skill_id: 'review', expected_version: 3, paths: ['refs/checklist.md'],
    }));
  });

  it('keeps the latest Skill detail when an older request finishes last', async () => {
    const pendingSkillA = deferred<{
      skill_id: string;
      name: string;
      description: string;
      version: number;
      status: string;
      content: string;
      manifest: never[];
    }>();
    coreRequest.mockImplementation((route: string, body?: { skill_id?: string }) => {
      if (route === '/v3/conversation/query') return Promise.resolve({ messages: [] });
      if (route === '/v3/skill/list') {
        return Promise.resolve({ items: [
          { skill_id: 'skill-a', name: 'skill-a', description: 'Skill A', version: 1, status: 'active' },
          { skill_id: 'skill-b', name: 'skill-b', description: 'Skill B', version: 2, status: 'active' },
        ] });
      }
      if (route === '/v3/skill/get') {
        if (body?.skill_id === 'skill-a') return pendingSkillA.promise;
        return Promise.resolve({
          skill_id: 'skill-b', name: 'skill-b', description: 'Skill B', version: 2,
          status: 'active', content: '# Skill B', manifest: [],
        });
      }
      if (route === '/v3/skill/versions') return Promise.resolve({ items: [] });
      return Promise.resolve({});
    });

    render(<AssetCenter />);
    fireEvent.click(screen.getByText('Skills'));
    const openSkillA = await screen.findByRole('button', { name: '查看 skill-a' });
    const openSkillB = screen.getByRole('button', { name: '查看 skill-b' });
    fireEvent.click(openSkillA);
    fireEvent.click(openSkillB);
    expect(await screen.findByDisplayValue('# Skill B')).toBeTruthy();

    await act(async () => {
      pendingSkillA.resolve({
        skill_id: 'skill-a', name: 'skill-a', description: 'Skill A', version: 1,
        status: 'active', content: '# Skill A', manifest: [],
      });
      await pendingSkillA.promise;
    });

    expect(screen.queryByDisplayValue('# Skill A')).toBeNull();
    expect(screen.getByDisplayValue('# Skill B')).toBeTruthy();
  });

  it('searches Skills with the Core limit and archives after confirmation', async () => {
    coreRequest.mockImplementation((route: string) => {
      if (route === '/v3/conversation/query') return Promise.resolve({ messages: [] });
      if (route === '/v3/skill/list' || route === '/v3/skill/search') {
        return Promise.resolve({ items: [{ skill_id: 'review', name: 'review', description: 'Review', version: 2, status: 'active' }] });
      }
      return Promise.resolve({});
    });
    render(<AssetCenter />);
    fireEvent.click(screen.getByText('Skills'));
    await screen.findByText('Review');
    fireEvent.change(screen.getByPlaceholderText('搜索 Skills'), { target: { value: 'review' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索 Skills' }));
    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith('/v3/skill/search', { query: 'review', top_k: 50 }));
    fireEvent.click(screen.getByRole('button', { name: '归档 review' }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => expect(coreRequest).toHaveBeenCalledWith('/v3/skill/delete', {
      skill_id: 'review', expected_version: 2,
    }));
    expect(reloadSkills).toHaveBeenCalled();
  });

  it('renders a recoverable error state for Core failures', async () => {
    coreRequest.mockRejectedValueOnce(new Error('Core unavailable'));
    render(<AssetCenter />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Core unavailable');
    coreRequest.mockResolvedValue({ messages: [{ id: 'retry', role: 'user', content: '重试成功' }] });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('重试成功')).toBeTruthy();
  });

  it('clears stale rows and disables mutations when disconnected', async () => {
    const view = render(<AssetCenter />);
    expect(await screen.findByText('记住深色主题')).toBeTruthy();
    connection.status = { state: 'stopped', mode: 'local', knowledgeEndpoint: 'http://k/v3' };
    view.rerender(<AssetCenter />);
    await waitFor(() => expect(screen.queryByText('记住深色主题')).toBeNull());
    expect(screen.getByRole('button', { name: '清空整个空间' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '搜索' })).toBeDisabled();
  });

  it('rejects Skill names outside the Core lowercase slug schema', async () => {
    render(<AssetCenter />);
    fireEvent.click(screen.getByText('Skills'));
    fireEvent.click(screen.getByRole('button', { name: '新建 Skill' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: 'Upper_Name' } });
    fireEvent.change(within(dialog).getByLabelText('描述'), { target: { value: 'desc' } });
    fireEvent.change(within(dialog).getByLabelText('正文'), { target: { value: 'body' } });
    expect(within(dialog).getByText('仅支持小写字母、数字和连字符，且必须以字母或数字开头')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '创建' })).toBeDisabled();
  });
});
