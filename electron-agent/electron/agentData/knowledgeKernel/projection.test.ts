import {describe,it,expect} from 'vitest';
import {projectKnowledgeSnapshot} from './projection';
import {DEFAULT_KNOWLEDGE_BUDGETS} from '../../../shared/knowledgeKernelContracts';
import type {Job} from '../jobStore';
const metadata=()=>({version:1 as const,key:{workspaceInstanceId:'w',projectId:'p',portableProjectId:'p',branch:'main',language:'en',domain:'wiki' as const},intent:'generate' as const,revision:0,phase:'prepare' as const,pipelineConfigHash:'p',budgets:structuredClone(DEFAULT_KNOWLEDGE_BUDGETS),resumePolicy:'auto' as const,counts:{planned:0,prepared:0,failed:0,blocked:0,published:0}});
const job=(state:Job['state'],patch:Record<string,unknown>={}):Job=>({id:'id',kind:'repoWiki.generate',workspace:'/repo',state,progress:0,createdAt:1,updatedAt:2,metadata:{repoWiki:{...metadata(),...patch}}});
describe('knowledge projection',()=>{
 it('does not claim completed output is current without verified freshness',()=>expect(projectKnowledgeSnapshot(job('completed'),{state:'available',publishedCount:2,preparedCount:2,expectedCount:2}).content.state).toBe('available'));
 it('disables cancellation while publication is pinned',()=>expect(projectKnowledgeSnapshot(job('running',{publication:{id:'p',claimId:'c',intentHash:'h',state:'claimed'}})).run?.capabilities).toMatchObject({cancel:false,pause:false}));
 it('projects pause and repair capabilities from task state',()=>{expect(projectKnowledgeSnapshot(job('paused',{pauseCause:'user',resumePolicy:'manual'})).run?.capabilities.resume).toBe(true);expect(projectKnowledgeSnapshot(job('failed')).run?.capabilities.repair).toBe(true);expect(projectKnowledgeSnapshot(job('blocked')).run?.capabilities.reanalyse).toBe(true);});
});
it('projects a queued pause request as pause requested',()=>{const snapshot=projectKnowledgeSnapshot(job('pending',{control:{requestId:'r',action:'pause',cause:'user',requestedAt:1}}));expect(snapshot.run?.state).toBe('pause_requested');});

it('allows a new repair for a cancelled task',()=>expect(projectKnowledgeSnapshot(job('cancelled')).run?.capabilities.repair).toBe(true));

it('allows cancellation after a pause request has reached paused state',()=>{expect(projectKnowledgeSnapshot(job('paused',{resumePolicy:'manual',control:{requestId:'pause',action:'pause',cause:'user',requestedAt:1}})).run?.capabilities.cancel).toBe(true);});
