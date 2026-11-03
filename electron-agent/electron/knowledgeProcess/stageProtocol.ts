import type { KnowledgeDependency, KnowledgeMessageInput, KnowledgeUsage } from '../../shared/knowledgeKernelContracts';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { KnowledgeSourceFile } from './readTools';

export interface KnowledgeStageInput { root: string; manifest: KnowledgeSourceFile[]; systemPrompt: string; userPrompt: string; dependencies?: KnowledgeDependency[] }
export interface KnowledgeStagePorts {
  /** The controller acquires the shared model slot and reserves model/provider time before dispatch. */
  requestModel(input: KnowledgeMessageInput, signal?: AbortSignal): Promise<AssistantMessage>;
  reserve(input: { requestId: string; kind: 'tool' | 'time'; reserved: KnowledgeUsage }): Promise<void>;
  finish(requestId: string, actual: KnowledgeUsage): Promise<void>;
  markDispatched?(requestId: string): Promise<void>;
  release?(requestId: string): Promise<void>;
}
