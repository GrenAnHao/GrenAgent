import {clickText,themesAndNarrow} from '../sessionWorkflowProbe.mjs';
export default async function(t){
 await t.waitFor('[aria-label="编辑目标"]');await t.click('[aria-label="编辑目标"] .ant-radio-wrapper');await t.waitFor('[aria-label="替换文本"]');
 t.ok('原文与有效内容分开',(await t.text('body')).includes('持久原文')&&(await t.text('body')).includes('当前有效内容'));
 await t.click('[aria-label="替换文本"]');await t.key('a',['control']);await t.type('人工摘要');await clickText(t,'保存替换');t.ok('保存替换请求',(await t.events()).some(x=>x.startsWith('edit:user')));
 await t.click('[aria-label="编辑目标"] .ant-radio-wrapper:nth-child(2)');await clickText(t,'恢复原始完整内容');t.ok('恢复追加完整原文命令',(await t.events()).some(x=>x.startsWith('restore-original:assistant')));
 await t.act('rejectPair');await clickText(t,'保存替换');t.ok('协议配对拒绝可见',(await t.text('body')).includes('工具调用与结果配对校验失败'));
 await t.act('remount');await t.click('[aria-label="编辑目标"] .ant-radio-wrapper');t.ok('重挂载仍可检查持久原文',(await t.text('body')).includes('持久原文'));
 await t.act('omit');t.ok('native omit仍显示持久原文',(await t.text('body')).includes('最初用户请求'));t.ok('native omit与压缩窗口明确区分',(await t.text('body')).includes('本分支已省略'));
 await t.act('exclude');t.ok('旧排除阻止说明',(await t.text('body')).includes('请先从原消息'));
 await t.act('refreshFail');await t.waitFor('[data-testid="session-workflow-panel"] .ant-alert-error');t.ok('重载前保存被禁用',await t.js("[...document.querySelectorAll('button')].find(e=>e.textContent==='保存替换').disabled"));t.ok('刷新失败需要重开',(await t.text('body')).includes('修改已保存'));
 await themesAndNarrow(t,'session-context-edits');
}
