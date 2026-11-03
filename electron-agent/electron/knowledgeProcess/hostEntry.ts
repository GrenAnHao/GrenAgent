import { registerKnowledgeChildHost, registerNativeChildHost } from '../../vendor/repo-wiki/packages/process/src/child';
import { KnowledgeWorkerHost } from './host';
import { NativeWikiHost } from '../wikiService/host';
import { NativeWikiProjectAdapter } from '../wikiService/projectAdapter';

registerKnowledgeChildHost((service, reverse) => new KnowledgeWorkerHost(service, reverse));

registerNativeChildHost((service, reverse) => new NativeWikiHost(reverse, new NativeWikiProjectAdapter(service)));


