import type { AgentJob, MemoryOverview, WikiOverview, TaskView, ResourceNavigation, WorkbenchOverview } from '../../lib/agentData';
import type { AgentDataTab } from './agentDataViewTypes';
import { styles } from './agentDataStyles';

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

export function OverviewPanel({ memory, wiki, jobs, jobsLoading, jobsLoaded, jobsError, onNavigate, onOpenTask, workbench, tasks, onOpenResource }: OverviewPanelProps) {
  const aggregate = workbench?.data;
  const taskRows = tasks?.slice(0, 8);
  const jobRows = jobs.slice(0, 8);
  return <>
    <div className={styles.sectionHeading}><h3 className={styles.heading}>数据概览</h3><span className={styles.hint}>全部项目</span></div>
    <div className={styles.kpis}>
      <Metric label="Memory" value={memory.data?.total ?? '未获取'} meta={memory.data ? `L0-L3 · ${memory.data.byLevel.L0}/${memory.data.byLevel.L1}/${memory.data.byLevel.L2}/${memory.data.byLevel.L3}` : memory.loading ? '正在加载记忆统计' : '记忆统计暂不可用'} error={memory.error} onClick={() => onNavigate('memory')} />
      <Metric label="Wiki 页面" value={wiki.data?.pages ?? '未获取'} meta={wiki.data ? wiki.data.latestUpdatedAt === null ? '暂无更新' : `更新于 ${new Date(wiki.data.latestUpdatedAt).toLocaleString()}` : wiki.loading ? '正在加载页面统计' : '页面统计暂不可用'} error={wiki.error} onClick={() => onNavigate('wiki')} />
      <Metric label="代码索引" value="按项目查看" meta="选择一个代码项目查看索引" onClick={() => onNavigate('code')} />
      <Metric label={tasks ? '已加载任务' : '任务'} value={jobsLoaded ? tasks?.length ?? jobs.length : '未获取'} meta={jobsLoading ? '正在刷新任务' : !jobsLoaded ? '等待获取任务' : tasks ? '包含用户与系统任务；完整计数见下方' : `${jobs.filter((job) => job.state === 'pending' || job.state === 'running').length} 项进行中`} error={jobsError} onClick={() => onNavigate('jobs')} />
    </div>
    {workbench ? <>
      {workbench.error ? <div className={styles.inlineError} role="alert">{workbench.error}</div> : null}
      {aggregate?.errors.map((error) => <div key={error.domain} className={styles.inlineError} role="alert">{error.message}</div>)}
      <div className={styles.statStrip}>
        <Stat label="知识库" value={aggregate?.libraries?.total ?? '未获取'} meta={aggregate?.libraries ? `${aggregate.libraries.pendingSources} 份资料待处理` : '知识库统计尚未获取'} onClick={() => onOpenResource?.({ view: 'wiki' })} />
        <Stat label="活动任务" value={aggregate?.activeTasks ?? '未获取'} meta="包含用户与后台系统任务" onClick={() => onOpenResource?.({ view: 'jobs' })} />
        <Stat label="失败任务" value={aggregate?.failedTasks ?? '未获取'} meta="打开任务列表查看原因" onClick={() => onOpenResource?.({ view: 'jobs' })} />
        <Stat label="诊断" value={aggregate?.diagnostics?.actionRequired ?? '未检查'} meta={aggregate?.diagnostics ? `${aggregate.diagnostics.unchecked} 项未检查` : '检查不会自动修复'} onClick={() => onOpenResource?.({ view: 'audit' })} />
      </div>
      <div className={styles.toolbar}>
        <button type="button" className={`${styles.actionButton} ${styles.primaryButton}`} onClick={() => onOpenResource?.({ view: 'wiki', mode: 'create' })}>新建知识库</button>
        <button type="button" className={styles.actionButton} onClick={() => onOpenResource?.({ view: 'memory', mode: 'create' })}>新增记忆</button>
      </div>
      <div className={styles.columns}>
        <section className={styles.panelCard}>
          <div className={styles.panelCardHead}><h3 className={styles.panelCardTitle}>最近知识页面</h3></div>
          <div className={styles.list}>
            {aggregate?.recentPages.map((page) => <button key={`${page.kbId}:${page.pageId}`} type="button" title={`${page.title} · ${page.libraryName}`} className={styles.listRow} aria-label={`打开页面 ${page.title} · ${page.libraryName}`} onClick={() => onOpenResource?.({ view: 'wiki', kbId: page.kbId, pageId: page.pageId })}>
              <span className={styles.listTitle}>{page.title}</span>
              <span className={styles.listMeta}>{page.libraryName}</span>
            </button>)}
            {aggregate && !aggregate.recentPages.length && !aggregate.errors.some((error) => error.domain === 'wiki') ? <p className={styles.listEmpty}>暂无最近页面</p> : null}
          </div>
        </section>
        <section className={styles.panelCard}>
          <div className={styles.panelCardHead}><h3 className={styles.panelCardTitle}>最近记忆</h3></div>
          <div className={styles.list}>
            {aggregate?.recentMemories.map((record) => <button key={record.id} type="button" title={record.content} className={styles.listRow} aria-label={`打开记忆 ${record.content}`} onClick={() => onOpenResource?.({ view: 'memory', id: record.id })}>
              <span className={styles.listTitle}>{record.content}</span>
            </button>)}
            {aggregate && !aggregate.recentMemories.length && !aggregate.errors.some((error) => error.domain === 'memory') ? <p className={styles.listEmpty}>暂无最近记忆</p> : null}
          </div>
        </section>
      </div>
    </> : null}
    <section className={styles.panelCard}>
      <div className={styles.panelCardHead}><h3 className={styles.panelCardTitle}>最近任务</h3><span className={styles.hint}>{jobsLoaded ? `${tasks?.length ?? jobs.length} 项` : '未获取'}</span></div>
      {taskRows ? taskRows.length ? <table className={styles.table}><thead><tr><th>任务</th><th>状态</th><th>阶段 / 进度</th></tr></thead><tbody>{taskRows.map((task) => <tr key={task.key}>
        <td><button type="button" className={styles.textButton} aria-label={`查看任务 ${task.label}`} onClick={() => onOpenResource?.({ view: 'jobs', task: task.ref })}>{task.label} · {task.ref.source === 'user' ? '用户' : '系统'}</button></td>
        <td>{task.cancellationRequested ? '正在取消' : stateLabels[task.status]}</td><td>{task.stage ?? (task.progress === undefined ? '未提供进度' : `${task.progress}%`)}</td>
      </tr>)}</tbody></table> : <p className={styles.listEmpty}>{jobsLoaded ? '暂无任务' : '任务未获取'}</p> : jobs.length === 0 ? <p className={styles.listEmpty}>{jobsError ? '任务暂不可用，请重试刷新' : !jobsLoaded ? '等待获取任务' : jobsLoading ? '正在刷新任务...' : '暂无任务'}</p> :
        <table className={styles.table}><thead><tr><th>任务</th><th>状态</th><th>进度</th></tr></thead>
          <tbody>{jobRows.map((job) => <tr key={job.id}>
            <td><button type="button" className={styles.textButton} aria-label={`查看任务 ${job.kind}`} onClick={() => onOpenTask(job.id)}>{job.kind}</button></td>
            <td>{stateLabels[job.state]}</td><td>{job.progress}%</td>
          </tr>)}</tbody></table>}
    </section>
  </>;
}

function Metric({ label, value, meta, error, onClick }: { label: string; value: string | number; meta: string; error?: string; onClick(): void }) {
  const compact = typeof value === 'string' && !/^\d+$/.test(value);
  return <div>
    <button type="button" className={`${styles.card} ${styles.metricButton}`} onClick={onClick}>
      <span className={styles.cardLabel}>{label}</span><span className={`${styles.cardValue} ${compact ? styles.cardValueCompact : ''}`}>{value}</span><span className={styles.cardMeta}>{meta}</span>
    </button>
    {error ? <div className={styles.inlineError} role="alert">{error}</div> : null}
  </div>;
}

function Stat({ label, value, meta, onClick }: { label: string; value: string | number; meta: string; onClick(): void }) {
  return <button type="button" className={styles.stat} onClick={onClick} title={meta}>
    <span className={styles.statLabel}>{label}</span>
    <span className={styles.statValue}>{value}</span>
    <span className={styles.cardMeta}>{meta}</span>
  </button>;
}
