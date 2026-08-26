import { Button, Input } from 'antd';
import { cx } from 'antd-style';
import { useEffect, useMemo, useState } from 'react';
import { tencentdbApi, type TencentdbKnowledgeAssets, type TencentdbWikiPage, type TencentdbWikiPageContent, type TencentdbWikiSearchResponse } from '../../../../features/tencentdb/tencentdbApi';
import { wsStyles as s } from './styles';

export const projectContextTabs = [
  { id: 'overview', label: '概览' },
  { id: 'wiki', label: 'Wiki' },
  { id: 'codegraph', label: 'CodeGraph' },
  { id: 'memory', label: '记忆' },
  { id: 'git', label: 'Git' },
] as const;

export type ProjectContextTab = (typeof projectContextTabs)[number]['id'];

interface ProjectContextTabsProps {
  activeTab: ProjectContextTab;
  knowledge: TencentdbKnowledgeAssets | null;
  onTabChange: (tab: ProjectContextTab) => void;
}

function scopedAssets(knowledge: TencentdbKnowledgeAssets | null) {
  const wiki = knowledge?.workspace?.wikiId
    ? knowledge.wikis.find((item) => item.wiki_id === knowledge.workspace?.wikiId)
    : undefined;
  const codeGraph = knowledge?.workspace?.codeGraphId
    ? knowledge.codeGraphs.find((item) => item.code_graph_id === knowledge.workspace?.codeGraphId)
    : undefined;
  return { wiki, codeGraph };
}

function ProjectOverviewTab({ knowledge }: { knowledge: TencentdbKnowledgeAssets | null }) {
  const { wiki, codeGraph } = useMemo(() => scopedAssets(knowledge), [knowledge]);
  if (!knowledge) return <div className={s.projectContextEmpty}>正在读取项目知识。</div>;

  return (
    <div className={s.projectContextOverview}>
      <div><strong>{wiki ? '1' : '0'} 个 Wiki</strong><span>{wiki?.name ?? '未关联 Wiki'}</span></div>
      <div><strong>{codeGraph?.stats?.files ?? 0} 个文件</strong><span>CodeGraph 索引文件</span></div>
      <div><strong>{codeGraph?.stats?.nodes ?? 0} 个节点</strong><span>CodeGraph 符号节点</span></div>
    </div>
  );
}

function ProjectWikiTab({ active, assetId }: { active: boolean; assetId?: string }) {
  const [pages, setPages] = useState<TencentdbWikiPage[]>([]);
  const [content, setContent] = useState<TencentdbWikiPageContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<TencentdbWikiSearchResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPages([]);
    setContent(null);
    setError(null);
    setQuery('');
    setSearch(null);
    if (!active || !assetId) return () => { cancelled = true; };
    void tencentdbApi.listWikiPages(assetId)
      .then((result) => { if (!cancelled) setPages(result.items); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [active, assetId]);

  const readPage = async (page: TencentdbWikiPage) => {
    if (!assetId) return;
    setError(null);
    try {
      const result = await tencentdbApi.readWikiPages(assetId, [page.path]);
      setContent(result.items[0] ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const searchPages = async () => {
    if (!assetId || !query.trim()) return;
    setError(null);
    try {
      setSearch(await tencentdbApi.searchWiki(assetId, query.trim(), 20));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (!assetId) return <div className={s.projectContextEmpty}>当前项目未关联 Wiki。</div>;
  return (
    <div className={s.projectContextStack}>
      <div className={s.projectContextSearch}>
        <Input aria-label="搜索 Wiki" value={query} onChange={(event) => setQuery(event.target.value)} onPressEnter={() => void searchPages()} />
        <Button aria-label="搜索 Wiki" disabled={!query.trim()} onClick={() => void searchPages()}>搜索</Button>
      </div>
      {error ? <div role="alert">{error}</div> : null}
      {search?.results.map((result) => (
        <div className={s.projectContextResult} key={result.path}>
          <div><strong>{result.title}</strong><span>{result.snippet}</span></div>
          <Button size="small" aria-label={`阅读${result.title}`} onClick={() => void readPage({ id: result.path, title: result.title, type: result.type, path: result.path })}>阅读</Button>
        </div>
      ))}
      {pages.map((page) => (
        <div className={s.projectContextResult} key={page.id}>
          <div><strong>{page.title}</strong>{page.description ? <span>{page.description}</span> : null}</div>
          <Button size="small" aria-label={`阅读${page.title}`} onClick={() => void readPage(page)}>阅读</Button>
        </div>
      ))}
      {pages.length === 0 ? <div className={s.projectContextEmpty}>暂无 Wiki 页面。</div> : null}
      {content?.content ? <pre className={s.projectContextCode}>{content.content}</pre> : null}
    </div>
  );
}

function ProjectCodeGraphTab({ active, assetId }: { active: boolean; assetId?: string }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setQuery('');
      setResult(null);
      setError(null);
    }
  }, [active, assetId]);

  const search = async () => {
    if (!assetId || !query.trim()) return;
    setError(null);
    try {
      const response = await tencentdbApi.searchCodeGraph(assetId, query.trim(), 20);
      if (response.isError) setError(response.text);
      else setResult(response.text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (!assetId) return <div className={s.projectContextEmpty}>当前项目未关联 CodeGraph。</div>;
  return (
    <div className={s.projectContextStack}>
      <div className={s.projectContextSearch}>
        <Input aria-label="搜索 CodeGraph 符号" value={query} onChange={(event) => setQuery(event.target.value)} onPressEnter={() => void search()} />
        <Button aria-label="搜索 CodeGraph" type="primary" disabled={!query.trim()} onClick={() => void search()}>搜索</Button>
      </div>
      {error ? <div role="alert">{error}</div> : null}
      {result ? <pre className={s.projectContextCode}>{result}</pre> : <div className={s.projectContextEmpty}>输入符号名以查询代码图谱。</div>}
    </div>
  );
}

/** 项目上下文的标签壳；各标签的真实数据内容由后续功能填充。 */
export function ProjectContextTabs({ activeTab, knowledge, onTabChange }: ProjectContextTabsProps) {
  const active = projectContextTabs.find((tab) => tab.id === activeTab) ?? projectContextTabs[0];
  const { wiki, codeGraph } = useMemo(() => scopedAssets(knowledge), [knowledge]);

  return (
    <>
      <div aria-label="项目上下文标签" className={s.projectContextTabList} role="tablist">
        {projectContextTabs.map((tab) => (
          <button
            aria-controls={`project-context-panel-${tab.id}`}
            aria-selected={tab.id === activeTab}
            className={cx(s.projectContextTab, tab.id === activeTab && s.projectContextTabActive)}
            id={`project-context-tab-${tab.id}`}
            key={tab.id}
            role="tab"
            type="button"
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <section
        aria-labelledby={`project-context-tab-${active.id}`}
        className={s.projectContextTabPanel}
        id={`project-context-panel-${active.id}`}
        role="tabpanel"
      >
        {activeTab === 'overview' ? <ProjectOverviewTab knowledge={knowledge} /> : null}
        {activeTab === 'wiki' ? <ProjectWikiTab active assetId={wiki?.wiki_id} /> : null}
        {activeTab === 'codegraph' ? <ProjectCodeGraphTab active assetId={codeGraph?.code_graph_id} /> : null}
        {activeTab === 'memory' ? '记忆内容' : null}
        {activeTab === 'git' ? 'Git 内容' : null}
      </section>
    </>
  );
}
