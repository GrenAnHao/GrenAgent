import { Alert, Button, Empty, Input, Modal, Spin, Tag } from 'antd';
import { Flexbox, Segmented } from '@lobehub/ui';
import { Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../../store';
import {
  tencentdbApi,
  useTencentdbConnection,
  type TencentdbAsset,
  type TencentdbSkillDetail,
  type TencentdbSkillSummary,
} from './tencentdbApi';
import { KnowledgeManager } from './KnowledgeManager';

const ASSETS = [
  ['chat-memory', 'Chat Memory', 'L0 对话、L1 原子记忆、L2 场景与 L3 个人画像'],
  ['skills', 'Skills', '按 Agent 装备的版本化 SKILL.md 与资源'],
  ['wiki', 'Wiki', 'MemoryKnowledge 文档与检索索引'],
  ['codegraph', 'CodeGraph', '仓库符号、调用关系与影响分析'],
] as const;

type MemoryLevel = 'l0' | 'l1' | 'l2' | 'l3';
type MemoryRow = {
  id: string;
  title: string;
  content: string;
  meta?: string;
};

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const FIXED_ASSET_PAGE_SIZE = 100;

function ChatMemoryManager({ enabled }: { enabled: boolean }) {
  const [level, setLevel] = useState<MemoryLevel>('l0');
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MemoryRow | 'all' | null>(null);
  const serverQuery = level === 'l0' || level === 'l1' ? submittedQuery : '';
  const loadGeneration = useRef(0);
  const scope = useRef({ enabled, level, serverQuery });
  scope.current = { enabled, level, serverQuery };

  const load = useCallback(async () => {
    if (
      !enabled
      || scope.current.enabled !== enabled
      || scope.current.level !== level
      || scope.current.serverQuery !== serverQuery
    ) return;
    const generation = ++loadGeneration.current;
    const isCurrent = () => (
      loadGeneration.current === generation
      && scope.current.enabled === enabled
      && scope.current.level === level
      && scope.current.serverQuery === serverQuery
    );
    setLoading(true);
    setError(null);
    try {
      if (level === 'l0') {
        const data = serverQuery
          ? await tencentdbApi.coreRequest<{ messages?: Array<{ id?: string; role?: string; content?: string; timestamp?: string }> }>('/v3/conversation/search', { query: serverQuery, limit: 100 })
          : await tencentdbApi.coreRequest<{ messages?: Array<{ id?: string; role?: string; content?: string; timestamp?: string }> }>('/v3/conversation/query', { limit: 100, offset: 0 });
        if (!isCurrent()) return;
        setRows((data.messages ?? []).map((item, index) => ({
          id: item.id ?? '',
          title: item.content ?? `消息 ${index + 1}`,
          content: item.content ?? '',
          meta: [item.role, item.timestamp].filter(Boolean).join(' · '),
        })));
      } else if (level === 'l1') {
        const data = serverQuery
          ? await tencentdbApi.coreRequest<{ items?: Array<{ id: string; type?: string; content: string; background?: string }> }>('/v3/atomic/search', { query: serverQuery, limit: 100 })
          : await tencentdbApi.coreRequest<{ items?: Array<{ id: string; type?: string; content: string; background?: string }> }>('/v3/atomic/query', { limit: 100, offset: 0 });
        if (!isCurrent()) return;
        setRows((data.items ?? []).map((item) => ({
          id: item.id,
          title: item.content,
          content: [item.content, item.background].filter(Boolean).join('\n'),
          meta: item.type,
        })));
      } else if (level === 'l2') {
        const data = await tencentdbApi.coreRequest<{ entries?: Array<{ path: string; summary?: string; updated_at?: string }> }>('/v3/scenario/ls');
        if (!isCurrent()) return;
        setRows((data.entries ?? []).map((item) => ({
          id: item.path,
          title: item.path,
          content: item.summary ?? '',
          meta: item.updated_at,
        })));
      } else {
        const data = await tencentdbApi.coreRequest<{ content: string | null; updated_at?: string | null }>('/v3/core/read');
        if (!isCurrent()) return;
        setRows(!data.content?.trim() ? [] : [{ id: 'core', title: '个人核心画像', content: data.content, meta: data.updated_at ?? undefined }]);
      }
    } catch (cause) {
      if (!isCurrent()) return;
      setRows([]);
      setError(errorMessage(cause));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [enabled, level, serverQuery]);

  useEffect(() => {
    if (!enabled) {
      setRows([]);
      setQuery('');
      setSubmittedQuery('');
      setError(null);
      setLoading(false);
      setPendingDelete(null);
      return;
    }
    void load();
    return () => {
      loadGeneration.current += 1;
    };
  }, [enabled, load]);

  const visibleRows = useMemo(() => {
    if ((level === 'l0' || level === 'l1') || !submittedQuery) return rows;
    const needle = submittedQuery.toLocaleLowerCase();
    return rows.filter((row) => `${row.title}\n${row.content}`.toLocaleLowerCase().includes(needle));
  }, [level, rows, submittedQuery]);

  const changeLevel = (value: MemoryLevel) => {
    loadGeneration.current += 1;
    setLevel(value);
    setQuery('');
    setSubmittedQuery('');
    setRows([]);
    setPendingDelete(null);
  };

  const remove = async (row: MemoryRow) => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      if (level === 'l0') await tencentdbApi.coreRequest('/v3/conversation/delete', { message_ids: [row.id] });
      if (level === 'l1') await tencentdbApi.coreRequest('/v3/atomic/delete', { ids: [row.id] });
      if (level === 'l2') await tencentdbApi.coreRequest('/v3/scenario/rm', { path: row.id });
      if (level === 'l3') await tencentdbApi.coreRequest('/v3/core/write', { content: '' });
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
      setLoading(false);
    }
  };

  const clearAll = async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const fixedAssets: TencentdbAsset[] = [];
      let offset = 0;
      while (true) {
        const page = await tencentdbApi.coreRequest<{ items?: TencentdbAsset[]; total?: number }>('/v3/meta/agent-fixed-asset/list-with-detail', {
          limit: FIXED_ASSET_PAGE_SIZE,
          offset,
        });
        const pageItems = page.items ?? [];
        fixedAssets.push(...pageItems);
        offset += pageItems.length;
        if (pageItems.length < FIXED_ASSET_PAGE_SIZE || offset >= (page.total ?? offset)) break;
      }
      const memories = fixedAssets.filter((item) => item.asset_type === 'chat_memory');
      if (memories.length === 0) throw new Error('未找到当前 Chat Memory 资产');
      if (memories.length > 1) throw new Error('当前 Agent 存在多个 Chat Memory 资产');
      const memory = memories[0];
      const cleared = await tencentdbApi.coreRequest<{
        all_cleared?: boolean;
        items?: Array<{ memory_id?: string; cleared?: boolean; reason?: string }>;
      }>('/v3/chat-memory/clear', { memory_ids: [memory.asset_id] });
      const target = cleared.items?.find((item) => item.memory_id === memory.asset_id);
      if (cleared.all_cleared !== true || target?.cleared !== true) {
        throw new Error(target?.reason ?? 'Chat Memory 未完全清空');
      }
      setQuery('');
      setSubmittedQuery('');
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
      setLoading(false);
    }
  };

  return (
    <Flexbox gap={10} data-testid="chat-memory-manager">
      <Flexbox horizontal justify="space-between" align="center" gap={10}>
        <Segmented
          value={level}
          onChange={(value) => changeLevel(value as MemoryLevel)}
          options={[
            { value: 'l0', label: 'L0 对话' },
            { value: 'l1', label: 'L1 原子记忆' },
            { value: 'l2', label: 'L2 场景' },
            { value: 'l3', label: 'L3 核心画像' },
          ]}
        />
        <Button size="small" danger disabled={!enabled} icon={<Trash2 size={14} />} onClick={() => setPendingDelete('all')}>清空整个空间</Button>
      </Flexbox>
      <Flexbox horizontal gap={8}>
        <Input
          disabled={!enabled}
          value={query}
          placeholder="搜索当前层级"
          onChange={(event) => setQuery(event.target.value)}
          onPressEnter={() => setSubmittedQuery(query.trim())}
        />
        <Button size="small" disabled={!enabled} aria-label="搜索" icon={<Search size={14} />} onClick={() => setSubmittedQuery(query.trim())}>搜索</Button>
        <Button size="small" disabled={!enabled} aria-label="刷新" icon={<RefreshCw size={14} />} onClick={() => void load()} />
      </Flexbox>
      {pendingDelete ? (
        <Alert
          type="warning"
          title={pendingDelete === 'all' ? '将永久清空整个 Chat Memory 空间，是否继续？' : '删除此项？'}
          action={(
            <Flexbox horizontal gap={6}>
              <Button size="small" aria-label="取消" onClick={() => setPendingDelete(null)}>取消</Button>
              <Button
                size="small"
                danger
                disabled={!enabled}
                aria-label="确定"
                onClick={() => {
                  const target = pendingDelete;
                  setPendingDelete(null);
                  if (target === 'all') void clearAll(); else void remove(target);
                }}
              >确定</Button>
            </Flexbox>
          )}
        />
      ) : null}
      {error ? <Alert role="alert" type="error" title={error} action={<Button size="small" disabled={!enabled} aria-label="重试" onClick={() => void load()}>重试</Button>} /> : null}
      {loading ? <Spin size="small" /> : null}
      {!loading && !error && visibleRows.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前层级暂无记忆" /> : null}
      {!loading && enabled && visibleRows.map((row) => (
        <Flexbox key={row.id || row.title} horizontal justify="space-between" align="center" gap={12} style={{ borderBottom: '1px solid var(--ant-color-border)', padding: '8px 0' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{row.title}</div>
            {row.meta ? <small>{row.meta}</small> : null}
          </div>
          {row.id ? (
            <Button danger size="small" disabled={!enabled} aria-label={`删除 ${row.title}`} icon={<Trash2 size={14} />} onClick={() => setPendingDelete(row)} />
          ) : null}
        </Flexbox>
      ))}
    </Flexbox>
  );
}

function buildSkillMarkdown(name: string, description: string, body: string) {
  const content = body.trim();
  const safeDescription = JSON.stringify(description.replace(/\r?\n/g, ' ').trim());
  return `---\nname: ${name}\ndescription: ${safeDescription}\n---\n\n# ${name}\n\n${content}\n`;
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SKILL_NAME_ERROR = '仅支持小写字母、数字和连字符，且必须以字母或数字开头';

function SkillsManager({ enabled }: { enabled: boolean }) {
  const [skills, setSkills] = useState<TencentdbSkillSummary[]>([]);
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createBody, setCreateBody] = useState('');
  const [detail, setDetail] = useState<TencentdbSkillDetail | null>(null);
  const [versions, setVersions] = useState<TencentdbSkillSummary[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [skillContent, setSkillContent] = useState('');
  const [resourcePath, setResourcePath] = useState('');
  const [resourceContent, setResourceContent] = useState('');
  const [pendingArchive, setPendingArchive] = useState<TencentdbSkillSummary | null>(null);
  const [pendingResource, setPendingResource] = useState<string | null>(null);
  const detailGeneration = useRef(0);
  const scope = useRef({ enabled });
  scope.current = { enabled };
  const normalizedCreateName = createName.trim();
  const createNameValid = normalizedCreateName.length <= 64 && SKILL_NAME_PATTERN.test(normalizedCreateName);
  const canCreate = enabled && createNameValid && Boolean(createDescription.trim()) && Boolean(createBody.trim());

  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const data = submittedQuery
        ? await tencentdbApi.coreRequest<{ items?: TencentdbSkillSummary[] }>('/v3/skill/search', { query: submittedQuery, top_k: 50 })
        : await tencentdbApi.coreRequest<{ items?: TencentdbSkillSummary[] }>('/v3/skill/list', {
          filters: { status: ['active'] },
          pagination: { limit: 100, offset: 0 },
        });
      setSkills(data.items ?? []);
    } catch (cause) {
      setSkills([]);
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [enabled, submittedQuery]);

  useEffect(() => {
    if (!enabled) {
      setSkills([]);
      setQuery('');
      setSubmittedQuery('');
      setLoading(false);
      setError(null);
      setCreateOpen(false);
      setDetail(null);
      setVersions([]);
      setDetailLoading(false);
      setSkillContent('');
      setResourcePath('');
      setResourceContent('');
      setPendingArchive(null);
      setPendingResource(null);
      detailGeneration.current += 1;
      return;
    }
    void load();
    return () => {
      detailGeneration.current += 1;
    };
  }, [enabled, load]);

  const openDetail = useCallback(async (skillId: string) => {
    if (!enabled || scope.current.enabled !== enabled) return;
    const generation = ++detailGeneration.current;
    const isCurrent = () => (
      detailGeneration.current === generation
      && scope.current.enabled === enabled
    );
    setDetailLoading(true);
    setError(null);
    try {
      const [nextDetail, history] = await Promise.all([
        tencentdbApi.coreRequest<TencentdbSkillDetail>('/v3/skill/get', {
          skill_id: skillId,
          include_content: true,
          include_manifest: true,
        }),
        tencentdbApi.coreRequest<{ items?: TencentdbSkillSummary[] }>('/v3/skill/versions', {
          skill_id: skillId,
          pagination: { limit: 100, offset: 0 },
        }),
      ]);
      if (!isCurrent()) return;
      setDetail(nextDetail);
      setVersions(history.items ?? []);
      setSkillContent(nextDetail.content ?? '');
      setResourcePath('');
      setResourceContent('');
    } catch (cause) {
      if (!isCurrent()) return;
      setError(errorMessage(cause));
    } finally {
      if (isCurrent()) setDetailLoading(false);
    }
  }, [enabled]);

  const afterMutation = async (skillId?: string) => {
    if (!enabled) return;
    await tencentdbApi.reloadSkills();
    await load();
    if (skillId) await openDetail(skillId);
  };

  const createSkill = async () => {
    if (!enabled) return;
    const name = normalizedCreateName;
    const description = createDescription.trim();
    if (!createNameValid) {
      setError(SKILL_NAME_ERROR);
      return;
    }
    if (!description || !createBody.trim()) {
      setError('描述和正文不能为空');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await tencentdbApi.coreRequest('/v3/skill/create', {
        name,
        content: buildSkillMarkdown(name, description, createBody),
      });
      setCreateOpen(false);
      setCreateName('');
      setCreateDescription('');
      setCreateBody('');
      await afterMutation();
    } catch (cause) {
      setError(errorMessage(cause));
      setLoading(false);
    }
  };

  const updateSkill = async () => {
    if (!enabled || !detail) return;
    setDetailLoading(true);
    setError(null);
    try {
      await tencentdbApi.coreRequest('/v3/skill/update', {
        skill_id: detail.skill_id,
        expected_version: detail.version,
        content: skillContent,
      });
      await afterMutation(detail.skill_id);
    } catch (cause) {
      setError(errorMessage(cause));
      setDetailLoading(false);
    }
  };

  const readResource = async (path: string) => {
    if (!enabled || !detail) return;
    setDetailLoading(true);
    setError(null);
    try {
      const file = await tencentdbApi.coreRequest<{ path: string; content: string }>('/v3/skill/files/read', {
        skill_id: detail.skill_id,
        version: detail.version,
        path,
        encoding: 'utf-8',
      });
      setResourcePath(file.path);
      setResourceContent(file.content);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDetailLoading(false);
    }
  };

  const writeResource = async () => {
    if (!enabled || !detail || !resourcePath.trim()) return;
    setDetailLoading(true);
    setError(null);
    try {
      await tencentdbApi.coreRequest('/v3/skill/files/write', {
        skill_id: detail.skill_id,
        expected_version: detail.version,
        files: [{ path: resourcePath.trim(), content: resourceContent, encoding: 'utf-8' }],
      });
      await afterMutation(detail.skill_id);
    } catch (cause) {
      setError(errorMessage(cause));
      setDetailLoading(false);
    }
  };

  const removeResource = async (path: string) => {
    if (!enabled || !detail) return;
    setDetailLoading(true);
    setError(null);
    try {
      await tencentdbApi.coreRequest('/v3/skill/files/remove', {
        skill_id: detail.skill_id,
        expected_version: detail.version,
        paths: [path],
      });
      await afterMutation(detail.skill_id);
    } catch (cause) {
      setError(errorMessage(cause));
      setDetailLoading(false);
    }
  };

  const archiveSkill = async (skill: TencentdbSkillSummary) => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      await tencentdbApi.coreRequest('/v3/skill/delete', {
        skill_id: skill.skill_id,
        expected_version: skill.version,
      });
      if (detail?.skill_id === skill.skill_id) setDetail(null);
      await afterMutation();
    } catch (cause) {
      setError(errorMessage(cause));
      setLoading(false);
    }
  };

  return (
    <Flexbox gap={10} data-testid="skills-manager">
      <Flexbox horizontal gap={8} align="center">
        <Input disabled={!enabled} value={query} placeholder="搜索 Skills" onChange={(event) => setQuery(event.target.value)} onPressEnter={() => setSubmittedQuery(query.trim())} />
        <Button size="small" disabled={!enabled} aria-label="搜索 Skills" icon={<Search size={14} />} onClick={() => setSubmittedQuery(query.trim())}>搜索</Button>
        <Button size="small" disabled={!enabled} type="primary" icon={<Plus size={14} />} onClick={() => setCreateOpen(true)}>新建 Skill</Button>
      </Flexbox>
      {pendingArchive ? (
        <Alert
          type="warning"
          title={`归档 ${pendingArchive.name}？`}
          action={(
            <Flexbox horizontal gap={6}>
              <Button size="small" onClick={() => setPendingArchive(null)}>取消</Button>
              <Button size="small" danger disabled={!enabled} aria-label="确定" onClick={() => {
                const target = pendingArchive;
                setPendingArchive(null);
                void archiveSkill(target);
              }}>确定</Button>
            </Flexbox>
          )}
        />
      ) : null}
      {error ? <Alert role="alert" type="error" title={error} action={<Button size="small" disabled={!enabled} aria-label="重试" onClick={() => void load()}>重试</Button>} /> : null}
      {loading ? <Spin size="small" /> : null}
      {!loading && !error && skills.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无 Skills" /> : null}
      {!loading && enabled && skills.map((skill) => (
        <Flexbox key={skill.skill_id} horizontal justify="space-between" align="center" gap={12} style={{ borderBottom: '1px solid var(--ant-color-border)', padding: '8px 0' }}>
          <div>
            <strong>{skill.name}</strong> <Tag>v{skill.version}</Tag>
            <div>{skill.description}</div>
          </div>
          <Flexbox horizontal gap={6}>
            <Button size="small" disabled={!enabled} aria-label={`查看 ${skill.name}`} onClick={() => void openDetail(skill.skill_id)}>查看</Button>
            <Button size="small" danger disabled={!enabled} aria-label={`归档 ${skill.name}`} icon={<Trash2 size={14} />} onClick={() => setPendingArchive(skill)} />
          </Flexbox>
        </Flexbox>
      ))}
      <Modal title="新建 Skill" open={enabled && createOpen} onCancel={() => setCreateOpen(false)} footer={null}>
        <Flexbox gap={10}>
          <label htmlFor="skill-create-name">名称</label>
          <Input id="skill-create-name" disabled={!enabled} value={createName} onChange={(event) => setCreateName(event.target.value)} />
          {createName && !createNameValid ? <small>{SKILL_NAME_ERROR}</small> : null}
          <label htmlFor="skill-create-description">描述</label>
          <Input id="skill-create-description" disabled={!enabled} value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} />
          <label htmlFor="skill-create-body">正文</label>
          <Input.TextArea id="skill-create-body" disabled={!enabled} rows={8} value={createBody} onChange={(event) => setCreateBody(event.target.value)} />
          <Button type="primary" disabled={!canCreate} aria-label="创建" onClick={() => void createSkill()} loading={loading}>创建</Button>
        </Flexbox>
      </Modal>
      <Modal title={detail ? `${detail.name} · v${detail.version}` : 'Skill 详情'} open={enabled && (Boolean(detail) || detailLoading)} onCancel={() => {
        detailGeneration.current += 1;
        setDetailLoading(false);
        setDetail(null);
      }} footer={null} width={760}>
        {detailLoading && !detail ? <Spin size="small" /> : null}
        {detail ? (
          <Flexbox gap={12}>
            <Flexbox horizontal gap={6} align="center">
              <strong>{detail.description}</strong>
              <Tag>v{detail.version}</Tag>
              {versions.map((version) => <Tag key={version.version}>历史 v{version.version}</Tag>)}
            </Flexbox>
            <label htmlFor="skill-detail-content">SKILL.md</label>
            <Input.TextArea id="skill-detail-content" disabled={!enabled} rows={10} value={skillContent} onChange={(event) => setSkillContent(event.target.value)} />
            <Button size="small" type="primary" disabled={!enabled} aria-label="保存正文" onClick={() => void updateSkill()} loading={detailLoading}>保存正文</Button>
            <strong>Manifest 资源</strong>
            {(detail.manifest ?? []).length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无资源" /> : null}
            {(detail.manifest ?? []).map((entry) => (
              <Flexbox key={entry.path} horizontal justify="space-between" align="center">
                <span>{entry.path} · {entry.size_bytes} B</span>
                <Flexbox horizontal gap={6}>
                  <Button size="small" disabled={!enabled} aria-label={`读取 ${entry.path}`} onClick={() => void readResource(entry.path)}>读取</Button>
                  <Button size="small" danger disabled={!enabled} aria-label={`删除资源 ${entry.path}`} icon={<Trash2 size={14} />} onClick={() => setPendingResource(entry.path)} />
                </Flexbox>
              </Flexbox>
            ))}
            {pendingResource ? (
              <Alert
                type="warning"
                title={`删除资源 ${pendingResource}？`}
                action={(
                  <Flexbox horizontal gap={6}>
                    <Button size="small" onClick={() => setPendingResource(null)}>取消</Button>
                    <Button size="small" danger disabled={!enabled} aria-label="确定" onClick={() => {
                      const path = pendingResource;
                      setPendingResource(null);
                      void removeResource(path);
                    }}>确定</Button>
                  </Flexbox>
                )}
              />
            ) : null}
            <label htmlFor="skill-resource-path">资源路径</label>
            <Input id="skill-resource-path" disabled={!enabled} value={resourcePath} onChange={(event) => setResourcePath(event.target.value)} placeholder="references/example.md" />
            <label htmlFor="skill-resource-content">资源内容</label>
            <Input.TextArea id="skill-resource-content" disabled={!enabled} rows={6} value={resourceContent} onChange={(event) => setResourceContent(event.target.value)} />
            <Button size="small" aria-label="保存资源" onClick={() => void writeResource()} loading={detailLoading} disabled={!enabled || !resourcePath.trim()}>保存资源</Button>
          </Flexbox>
        ) : null}
      </Modal>
    </Flexbox>
  );
}

export function AssetCenter() {
  const { status } = useTencentdbConnection();
  const workspace = useSessionStore((state) => state.activeWorkspace);
  const [asset, setAsset] = useState<(typeof ASSETS)[number][0]>('chat-memory');
  const selected = ASSETS.find(([id]) => id === asset) ?? ASSETS[0];
  const connectionState = status?.state;
  const connectionMode = status?.mode;
  const knowledgeEndpoint = status?.knowledgeEndpoint;
  const coreEnabled = connectionState === 'ready' || connectionState === 'restart_required';
  const knowledgeEnabled = coreEnabled && (connectionMode !== 'remote' || Boolean(knowledgeEndpoint));

  return (
    <Flexbox gap={14} data-testid="tencentdb-asset-center">
      <Segmented block value={asset} onChange={(value) => setAsset(value as typeof asset)} options={ASSETS.map(([id, label]) => ({ value: id, label }))} />
      <div>
        <h3>{selected[1]}</h3>
        <p>{selected[2]}</p>
        <p>{coreEnabled ? 'Gateway 已连接，可管理当前连接范围内的远程资产。' : 'Gateway 未连接；连接成功后这里显示远程资产状态。'}</p>
        {status?.knowledgeEndpoint && (asset === 'wiki' || asset === 'codegraph') ? <p>Knowledge：{status.knowledgeEndpoint}</p> : null}
        {asset === 'chat-memory' ? <ChatMemoryManager enabled={coreEnabled} /> : null}
        {asset === 'skills' ? <SkillsManager enabled={coreEnabled} /> : null}
        {asset === 'codegraph' || asset === 'wiki' ? (
          <KnowledgeManager
            kind={asset}
            enabled={knowledgeEnabled}
            workspace={workspace || undefined}
          />
        ) : null}
      </div>
    </Flexbox>
  );
}
