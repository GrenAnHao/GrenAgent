import { countLines } from '../editor/pastedText';
import type { PastedText } from '../editor/types';

export interface ProjectContextCitation {
  text: string;
  source: string;
  label: string;
}

/** 将抽屉内容作为待发送附件保留，不能只发送 project:// 路径。 */
export function makeProjectContextPastedText(citation: ProjectContextCitation): PastedText {
  const text = citation.text;
  return {
    id: `project-context-${Date.now().toString(36)}`,
    text,
    lines: countLines(text),
    chars: text.length,
    source: citation.source,
    referenceOnly: false,
  };
}
