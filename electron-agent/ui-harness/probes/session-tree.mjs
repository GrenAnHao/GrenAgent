import {clickText,themesAndNarrow} from '../sessionWorkflowProbe.mjs';
export default async function(t){
 await t.waitFor('[aria-label="会话树节点"]');t.ok('完整旁支可见',(await t.text('body')).includes('旁支请求'));
 await t.click('.ant-tree-node-content-wrapper');await t.key('Home');await t.key('Down');await t.key('Enter');t.ok('键盘选择助手节点',(await t.text('.ant-tree-treenode-selected')).includes('当前助手回复'));await t.key('Down');await t.key('Right');t.ok('键盘展开技术子节点',(await t.text('body')).includes('技术记录'));
 await clickText(t,'最初用户请求','[role="treeitem"] .ant-tree-title span');
 await t.click('[aria-label="节点书签"]');await t.type('检查点');await clickText(t,'保存书签');t.ok('书签命名请求',(await t.events()).some(x=>x.startsWith('label:user')));
 await clickText(t,'预览继续位置');await t.waitFor('[data-testid="navigation-preview"]');t.ok('用户节点预览根位置',(await t.text('body')).includes('根位置'));
 t.ok('已有草稿必须先明确选择',await t.js("[...document.querySelectorAll('button')].find(e=>e.textContent==='确认导航').disabled"));await t.click('[aria-label="已有草稿处理"] .ant-radio-wrapper');await clickText(t,'确认导航');t.ok('草稿选择显式保留',(await t.events()).some(x=>x==='navigate:user::keep'));
 await clickText(t,'预览继续位置');await t.click('[aria-label="已有草稿处理"] .ant-radio-wrapper');await t.click('[data-testid="navigation-preview"] .ant-checkbox-wrapper');await clickText(t,'确认导航');await clickText(t,'取消摘要');t.ok('摘要取消沿显式命令回传',(await t.events()).some(x=>x.startsWith('cancel-summary:')));
 await t.act('draftEmpty');await clickText(t,'预览继续位置');t.ok('空草稿预览自动选择填回原文',(await t.text('body')).includes('草稿为空'));await t.click('[data-testid="navigation-preview"] .ant-checkbox-wrapper');await clickText(t,'确认导航');t.ok('空草稿确认后走replace而非keep',(await t.events()).some(e=>e==='navigate:user::replace'));t.check('确认后真实草稿存档填回原文',(await t.data()).draft,'最初用户请求');
 await clickText(t,'复制当前分支');await t.waitFor('[data-testid="derivation-preview"]');t.ok('复制先展示所选路径',(await t.text('[data-testid="derivation-preview"]')).includes('非完整会话树'));await t.shot('derivation-preview');await clickText(t,'取消复制');t.ok('取消复制零发布请求',!(await t.events()).some(e=>e.startsWith('clone:')));
 await clickText(t,'从此处分叉');await t.waitFor('[data-testid="derivation-preview"]');t.ok('分叉预览明确包含目标',(await t.text('[data-testid="derivation-preview"]')).includes('包含目标'));await clickText(t,'确认分叉');t.ok('只有确认后才提交分叉',(await t.events()).some(e=>e==='fork:user:at:'));
 await t.act('stale');await clickText(t,'保存书签');t.ok('stale要求刷新预览',(await t.text('body')).includes('SESSION_STALE'));
 await t.act('busy');t.ok('busy提示',(await t.text('body')).includes('结构操作暂不可用'));await t.act('idle');
 await themesAndNarrow(t,'session-tree');
}

