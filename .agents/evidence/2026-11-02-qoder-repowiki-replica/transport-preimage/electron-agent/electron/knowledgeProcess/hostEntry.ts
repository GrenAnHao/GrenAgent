import { registerKnowledgeChildHost } from '../../vendor/repo-wiki/packages/process/src/child';
import { KnowledgeWorkerHost } from './host';

registerKnowledgeChildHost((service, reverse) => new KnowledgeWorkerHost(service, reverse));
