import { Alert, Button, Card, Empty, Statistic, Table, Typography } from 'antd';
import type { AgentJob, MemoryOverview, WikiOverview, TaskView, ResourceNavigation, WorkbenchOverview } from '../../lib/agentData';
import type { AgentDataTab } from './agentDataViewTypes';
import { styles } from './agentDataStyles';
import { listRowStyles as rows } from './listRowStyles';

export interface ResourceState<T> { data?: T; loading: boolean; error?: string }

interface OverviewPanelProps {
  memory: ResourceState<MemoryOverview>;
  wiki: ResourceState<WikiOverview>;
  jobs: AgentJob[];
  jobsLoading: boolean;
  jobsLoaded: boolean;
  jobsError?: string;
  onNavigate(tab: AgentDataTab): void;
  onOpenTask(id: string): void;
  workbench?: ResourceState<WorkbenchOverview>;
  tasks?: TaskView[];
  onOpenResource?(navigation: ResourceNavigation): void;
}

const stateLabels = { pending: '等待中', queued: '排队中', blocked: '已阻塞', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' };
const flushBody = { body: { padding: 0 } };

export function OverviewPanel({ memory, wiki, jobs, jobsLoading, jobsLoaded, jobsError, onNavigate, onOpenTask, workbench, tasks, onOpenResource }: OverviewPanelProps) {
  const aggregate = workbench?.data;
  const taskRows = tasks?.slice(0, 8);
  const jobRows = jobs.slice(0, 8);
  const taskColumns = [
    {
      title: '任务', key: 'label',
      render: (_: unknown, task: TaskView) => <Button type="link" size="small" aria-label={`查看任务 ${task.label}`} onClick={() => onOpenResource?.({ view: 'jobs', task: task.ref })}>{task.label} · {task.ref.source === 'user' ? '用户' : '系统'}</Button>,
    },
    { title: '状态', key: 'status', render: (_: unknown, task: TaskView) => task.cancellationRequested ? '正在取消' : stateLabels[task.status] },
    { title: '阶段 / 进度', key: 'progress', render: (_: unknown, task: TaskView) => task.stage ?? (task.progress === undefined ? '未提供进度' : `${task.progress}%`) },
  ];
  const jobColumns = [
    {
      title: '任务', key: 'kind',
      render: (_: unknown, job: AgentJob) => <Button type="link" size="small" aria-label={`查看任务 ${job.kind}`} onClick={() => onOpenTask(job.id)}>{job.kind}</Button>,
    },
    { title: '状态', key: 'state', render: (_: unknown, job: AgentJob) => stateLabels[job.state] },
    { title: '进度', key: 'progress', render: (_: unknown, job: AgentJob) => `${job.progress}%` },
  ];
  return <>
    <div className={styles.sectionHeading}><Typography.Title level={5} style={{ margin: 0 }}>数据概览</Typography.Title><Typography.Text type="secondary">全部项目</Typography.Text></div>
    <div className={styles.kpis}>
      <Metric label="Memory" value={memory.data?.total ?? '未获取'} meta={memory.data ? `L0-L3 · ${memory.data.byLevel.L0}/${memory.data.byLevel.L1}/${memory.data.byLevel.L2}/${memory.data.byLevel.L3}` : memory.loading ? '正在加载记忆统计' : '记忆统计暂不可用'} error={memory.error} onClick={() => onNavigate('memory')} />
      <Metric label="Wiki 页面" value={wiki.data?.pages ?? '未获取'} meta={wiki.data ? wiki.data.latestUpdatedAt === null ? '暂无更新' : `更新于 ${new Date(wiki.data.latestUpdatedAt).toLocaleString()}` : wiki.loading ? '正在加载页面统计' : '页面统计暂不可用'} error={wiki.error} onClick={() => onNavigate('wiki')} />
      <Metric label="代码索引" value="按项目查看" meta="选择一个代码项目查看索引" onClick={() => onNavigate('code')} />
      <Metric label={tasks ? '已加载任务' : '任务'} value={jobsLoaded ? tasks?.length ?? jobs.length : '未获取'} meta={jobsLoading ? '正在刷新任务' : !jobsLoaded ? '等待获取任务' : tasks ? '包含用户与系统任务；完整计数见下方' : `${jobs.filter((job) => job.state === 'pending' || job.state === 'running').length} 项进行中`} error={jobsError} onClick={() => onNavigate('jobs')} />
    </div>
    {workbench ? <>
      {workbench.error ? <Alert type="error" showIcon title={workbench.error} /> : null}
      {aggregate?.errors.map((error) => <Alert key={error.domain} type="error" showIcon title={error.message} />)}
      <Card size="small" className={styles.statCard} classNames={{ body: styles.statStrip }} styles={flushBody}>
        <Stat label="知识库" value={aggregate?.libraries?.total ?? '未获取'} meta={aggregate?.libraries ? `${aggregate.libraries.pendingSources} 份资料待处理` : '知识库统计尚未获取'} onClick={() => onOpenResource?.({ view: 'wiki' })} />
        <Stat label="活动任务" value={aggregate?.activeTasks ?? '未获取'} meta="包含用户与后台系统任务" onClick={() => onOpenResource?.({ view: 'jobs' })} />
        <Stat label="失败任务" value={aggregate?.failedTasks ?? '未获取'} meta="打开任务列表查看原因" onClick={() => onOpenResource?.({ view: 'jobs' })} />
        <Stat label="诊断" value={aggregate?.diagnostics?.actionRequired ?? '未检查'} meta={aggregate?.diagnostics ? `${aggregate.diagnostics.unchecked} 项未检查` : '检查不会自动修复'} onClick={() => onOpenResource?.({ view: 'audit' })} />
      </Card>
      <div className={styles.toolbar}>
        <Button type="primary" onClick={() => onOpenResource?.({ view: 'wiki', mode: 'create' })}>新建知识库</Button>
        <Button onClick={() => onOpenResource?.({ view: 'memory', mode: 'create' })}>新增记忆</Button>
      </div>
      <div className={styles.columns}>
        <Card size="small" title="最近知识页面" className={styles.listCard} styles={flushBody}>
          {aggregate?.recentPages.map((page) => <Button key={`${page.kbId}:${page.pageId}`} block type="text" className={`${rows.row} ${rows.flush}`} title={`${page.title} · ${page.libraryName}`} aria-label={`打开页面 ${page.title} · ${page.libraryName}`} onClick={() => onOpenResource?.({ view: 'wiki', kbId: page.kbId, pageId: page.pageId })}>
            <span className={rows.title}>{page.title}</span>
            <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>{page.libraryName}</Typography.Text>
          </Button>)}
          {aggregate && !aggregate.recentPages.length && !aggregate.errors.some((error) => error.domain === 'wiki') ? <Empty description="暂无最近页面" /> : null}
        </Card>
        <Card size="small" title="最近记忆" className={styles.listCard} styles={flushBody}>
          {aggregate?.recentMemories.map((record) => <Button key={record.id} block type="text" className={`${rows.row} ${rows.flush}`} title={record.content} aria-label={`打开记忆 ${record.content}`} onClick={() => onOpenResource?.({ view: 'memory', id: record.id })}>
            <span className={rows.title}>{record.content}</span>
          </Button>)}
          {aggregate && !aggregate.recentMemories.length && !aggregate.errors.some((error) => error.domain === 'memory') ? <Empty description="暂无最近记忆" /> : null}
        </Card>
      </div>
    </> : null}
    <Card size="small" title="最近任务" extra={<Typography.Text type="secondary">{jobsLoaded ? `${tasks?.length ?? jobs.length} 项` : '未获取'}</Typography.Text>}>
      {taskRows ? taskRows.length
        ? <Table<TaskView> rowKey={(task) => `${task.ref.source}:${task.ref.id}`} size="small" pagination={false} columns={taskColumns} dataSource={taskRows} />
        : <Empty description={jobsLoaded ? '暂无任务' : '任务未获取'} />
        : jobs.length === 0
          ? <Empty description={jobsError ? '任务暂不可用，请重试刷新' : !jobsLoaded ? '等待获取任务' : jobsLoading ? '正在刷新任务...' : '暂无任务'} />
          : <Table<AgentJob> rowKey="id" size="small" pagination={false} columns={jobColumns} dataSource={jobRows} />}
    </Card>
  </>;
}

function Metric({ label, value, meta, error, onClick }: { label: string; value: string | number; meta: string; error?: string; onClick(): void }) {
  return <div>
    <Card hoverable size="small" role="button" tabIndex={0} onClick={onClick} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } }}>
      <Statistic title={label} value={value} />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{meta}</Typography.Text>
    </Card>
    {error ? <Alert type="error" showIcon title={error} /> : null}
  </div>;
}

function Stat({ label, value, meta, onClick }: { label: string; value: string | number; meta: string; onClick(): void }) {
  return <Button block type="text" className={`${rows.row} ${styles.stat}`} title={meta} onClick={onClick}>
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}</Typography.Text>
    <span className={styles.statValue}>{value}</span>
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{meta}</Typography.Text>
  </Button>;
}
