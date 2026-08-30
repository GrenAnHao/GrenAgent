import type { ChatMessage } from '../stores/agentReducer';

export function exportToMarkdown(messages: ChatMessage[]): string {
  let markdown = '# 对话导出\n\n';

  for (const msg of messages) {
    if (msg.kind === 'user') {
      markdown += `## 用户\n\n${msg.text}\n\n`;
    } else if (msg.kind === 'assistant') {
      markdown += `## 助手\n\n${msg.text}\n\n`;
    } else if (msg.kind === 'tool') {
      markdown += `### 🔧 ${msg.toolName}\n\n`;
      markdown += `**状态**: ${msg.status}\n\n`;
      markdown += `**参数**: \`\`\`json\n${JSON.stringify(msg.args, null, 2)}\n\`\`\`\n\n`;
      if (msg.result) {
        markdown += `**结果**: \`\`\`\n${typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result, null, 2)}\n\`\`\`\n\n`;
      }
    }
  }

  return markdown;
}

export function exportToJSON(messages: ChatMessage[]): string {
  return JSON.stringify(messages, null, 2);
}

export function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
