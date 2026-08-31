import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerCodeGraphTools } from './tools.js';

export default function codeRetrieval(pi: ExtensionAPI): void { registerCodeGraphTools(pi); }
