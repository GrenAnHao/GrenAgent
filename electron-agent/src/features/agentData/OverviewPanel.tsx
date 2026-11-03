import { Button, Empty, Tag } from 'antd';
import type { CodeGraphProject, ResourceNavigation, TaskView, WikiAssetDetail, WorkbenchOverview } from '../../lib/agentData';
import type { AgentDataTab } from './agentDataViewTypes';
import { formatRelative } from '../../lib/relativeTime';
import { taskStatusColors, taskStatusLabels } from './operationsPresentation';
import { PageHeader } from './workbench/PageHeader';
import { PageBanner, type BannerItem } from './workbench/PageBanner';
import { StatusTag } from './workbench/StatusTag';
import { overviewStyles as s } from './overviewStyles';

export interface ResourceState<T> { data?: T; loading: boolean; error?: string }
interface OverviewPanelProps {
  workbench: ResourceState<WorkbenchOverview>;
  libraries: ResourceState<WikiAssetDetail[]>;
  codeProjects: ResourceState<CodeGraphProject[]>;
  tasks: TaskView[];
  tasksLoaded: boolean;
  tasksError?: string;
  onNavigate(tab: AgentDataTab): void;
  onOpenResource(navigation: ResourceNavigation): void;
}

export function OverviewPanel({ workbench, libraries, codeProjects, tasks, tasksLoaded, tasksError, onNavigate, onOpenResource }: OverviewPanelProps) {
  const data = workbench.data;
  const projects = codeProjects.data;
  const errors: BannerItem[] = [
    workbench.error ? { source: '概览', message: workbench.error } : null,
    libraries.error ? { source: '知识库', message: libraries.error } : null,
    codeProjects.error ? { source: '代码索引', message: codeProjects.error } : null,
    tasksError ? { source: '任务', message: tasksError } : null,
    ...(data?.errors ?? []).map((error) => ({ source: error.domain, message: error.message })),
  ].filter(Boolean) as BannerItem[];
  const recentLibraries = [...(libraries.data ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 4);
  const kpis = [
    { tab: 'wiki' as const, value: data?.libraries?.pages, label: '个知识页面', meta: data?.libraries ? `${data.libraries.total} 个知识库` : '知识库统计未获取' },
    { tab: 'code' as const, value: projects ? `${projects.filter((p) => p.indexed).length} / ${projects.length}` : undefined, label: '个项目已索引', meta: '按已知项目统计' },
    { tab: 'jobs' as const, value: data?.activeTasks, label: '个进行中', meta: data?.failedTasks ? <span className={s.danger}>{data.failedTasks} 个失败</span> : '含后台任务' },
  ];
  return <>
    <PageHeader title="概览" subtitle="全部项目" actions={<>
      <Button type="primary" onClick={() => onOpenResource({ view: 'wiki', mode: 'create' })}>新建知识库</Button>
    </>} />
    <PageBanner type="error" items={errors} />
    {data?.diagnostics?.actionRequired ? <PageBanner type="error" items={[{ message: `有 ${data.diagnostics.actionRequired} 项诊断需要处理` }]} action={<Button size="small" autoInsertSpace={false} onClick={() => onNavigate('audit')}>查看</Button>} /> : null}
    <div className={s.kpis}>{kpis.map((kpi) => <button key={kpi.tab} type="button" className={s.kpi} aria-label={`${kpi.value ?? '未获取'} ${kpi.label}`} onClick={() => onNavigate(kpi.tab)}>
      <span className={s.kpiValue}>{kpi.value ?? '未获取'}</span>
      <span className={s.kpiLabel}>{kpi.label}</span>
      <span className={s.kpiMeta}>{kpi.meta}</span>
    </button>)}</div>
    <div className={s.columns}>
      <section className={s.list} aria-label="最近任务">
        <div className={s.listHeader}>最近任务<Button type="link" size="small" autoInsertSpace={false} onClick={() => onNavigate('jobs')}>全部</Button></div>
        {!tasksLoaded ? <Empty className={s.listEmpty} description="任务未获取" /> : !tasks.length ? <Empty className={s.listEmpty} description="暂无任务" /> :tasks.slice(0, 4).map((item) => <button key={item.key} type="button" className={s.row} aria-label={`查看任务 ${item.label}`} onClick={() => onOpenResource({ view: 'jobs', task: item.ref })}>
          <span className={s.rowMain}>{item.label}<small>{item.stage ?? item.error ?? formatRelative(item.updatedAt)}</small></span>
          <Tag color={taskStatusColors[item.status]}>{item.cancellationRequested ? '正在取消' : taskStatusLabels[item.status]}</Tag>
        </button>)}
      </section>
      <section className={s.list} aria-label="知识库">
        <div className={s.listHeader}>知识库<Button type="link" size="small" autoInsertSpace={false} onClick={() => onNavigate('wiki')}>全部</Button></div>
        {libraries.data && !recentLibraries.length ? <Empty className={s.listEmpty} description="还没有知识库" /> : recentLibraries.map((library) => <button key={library.wikiId} type="button" className={s.row} aria-label={`打开知识库 ${library.name}`} onClick={() => onOpenResource({ view: 'wiki', kbId: library.wikiId })}>
          <span className={s.rowMain}>{library.name}<small>{library.pageCount ?? 0} 页</small></span>
          <StatusTag domain="wiki" status={library.status} />
        </button>)}
      </section>
    </div>
  </>;
}
