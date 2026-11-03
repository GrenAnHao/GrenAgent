import type { Job } from '../jobStore';
import type { RepoWikiKnowledgeSnapshot, KnowledgeRunState } from '../../../shared/knowledgeKernelContracts';
export function projectKnowledgeSnapshot(job:Job, content?:RepoWikiKnowledgeSnapshot['content'], admission?:RepoWikiKnowledgeSnapshot['admission']):RepoWikiKnowledgeSnapshot {
 const meta=job.metadata?.repoWiki;if(!meta)throw new Error('KNOWLEDGE_METADATA_REQUIRED');
 const pinned=Boolean(meta.publication);const control=meta.control;
 const state:KnowledgeRunState=(job.state==='pending'||job.state==='running')&&control?.action==='pause'?'pause_requested':job.state==='pending'?'queued':job.state;
 const active=state==='queued'||state==='running';
 const settledPause=state==='paused'&&control?.action==='pause';
 const capabilities={pause:active&&!pinned&&!control,resume:state==='paused'&&meta.resumePolicy==='manual',cancel:(active||state==='paused'||state==='blocked')&&!pinned&&(!control||settledPause),repair:(state==='failed'||state==='cancelled')&&!pinned,reanalyse:state==='blocked'&&!pinned};
 return {version:1,key:meta.key,content:content??{state:'empty',publishedCount:0,preparedCount:meta.counts.prepared,expectedCount:meta.counts.planned},run:{taskId:job.id,revision:meta.revision,phase:meta.phase,state,counts:meta.counts,capabilities,...(!meta.executionPolicy&&meta.currentItem?{currentItem:meta.currentItem}:{}),...(meta.error?{error:meta.error}:{}),...(meta.outcome?{outcome:meta.outcome}:{}),updatedAt:job.updatedAt},action:{state:'idle'},admission:admission??{state:'preparing'}};
}


