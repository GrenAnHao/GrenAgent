import type { KnowledgeBuildStore } from './store';
import type { AsyncKnowledgeProjectPort } from './coordinator';
/** Caller must have drained the old executor before allowing cross-epoch reconciliation. */
export async function reconcilePinnedPublication(store:KnowledgeBuildStore,project:AsyncKnowledgeProjectPort,taskId:string):Promise<'none'|'settled'|'retry'|'blocked'> {
 const claim=store.readPublicationClaim(taskId);if(!claim)return 'none';const job=store.getTask(taskId),key=job?.metadata?.repoWiki?.key;if(!key)throw new Error('TASK_NOT_FOUND');
 try {const outcome=await project.reconcile(key.projectId,key.domain,claim);if(outcome.status==='matching'){try{await project.refreshIndex(key.projectId);}catch{store.blockPublication(taskId,claim.fence,{code:'INDEX_UPDATE_FAILED',message:'Published files require index rebuild',retriable:true},{previousExecutorExited:true});return 'blocked';}store.settlePublication(outcome.receipt);return 'settled';}if(outcome.status==='not_prepared'){store.releasePublicationClaim(taskId,claim.fence,claim.claimId,{previousExecutorExited:true});return 'retry';}}
 catch {/* Unknown receipt or journal must stay pinned. */}
 store.blockPublication(taskId,claim.fence,{code:'PUBLICATION_RECOVERY_CONFLICT',message:'Publication outcome requires reconciliation',retriable:false},{previousExecutorExited:true});return 'blocked';
}
