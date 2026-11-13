import {clickText,themesAndNarrow} from '../sessionWorkflowProbe.mjs';
export default async function(t){
 await t.waitFor('[data-testid="session-workflow-panel"]');t.ok('敏感原文提醒',(await t.text('body')).includes('文件保留敏感原文'));
 await clickText(t,'导出 HTML · 完整会话树');await t.waitFor('[data-testid="export-preview"]');t.ok('绝对目标预览',(await t.text('body')).includes('D:/exports/完整历史.html'));t.ok('覆盖另确认',(await t.text('body')).includes('确认覆盖并导出'));await clickText(t,'确认覆盖并导出');t.ok('覆盖需独立确认后才请求',(await t.events()).includes('overwrite:true'));
 await clickText(t,'导出 JSONL · 当前分支');t.ok('JSONL当前分支范围',(await t.text('body')).includes('不是全树备份'));await clickText(t,'取消导出');
 await t.act('badImport');await clickText(t,'导入本地 JSONL');t.ok('坏行报告精确定位',(await t.text('body')).includes('JSONL line 3'));
 await clickText(t,'导入本地 JSONL');await t.waitFor('[aria-label="确认导入工作目录"]');t.ok('只读无自动请求说明',(await t.text('body')).includes('不会自动发送'));await clickText(t,'确认目录并导入（不发送）');t.ok('确认导入请求',(await t.events()).some(x=>x.startsWith('import:')));t.ok('导入请求明确确认文件偏好',(await t.events()).includes('preferences:file'));
 await themesAndNarrow(t,'session-portability');
}
