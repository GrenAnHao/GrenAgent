import{mkdirSync,copyFileSync}from'node:fs';import{fileURLToPath}from'node:url';import{join}from'node:path';
const evidence=fileURLToPath(new URL('../../../.agents/evidence/2026-11-11-advanced-parameters-accordion/ui/',import.meta.url));
const q=id=>`[data-testid="${id}"]`;
const advancedHeader=`.ant-collapse-header:has(${q('prov-model-advanced-toggle-0')})`;
async function reveal(t,selector){await t.js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'})`);}
async function advanced(t,expanded=true){
 const expected=String(expanded);
 if(await t.js(`document.querySelector('${advancedHeader}')?.getAttribute('aria-expanded') !== '${expected}'`)){
  await reveal(t,advancedHeader);await t.click(advancedHeader,24);
 }
 t.ok(`高级参数组${expanded?'展开':'收起'} aria 状态正确`,await t.waitUntil(`document.querySelector('${advancedHeader}')?.getAttribute('aria-expanded') === '${expected}'`));
 if(expanded)t.ok('高级参数编辑器已挂载',await t.waitFor(q('advanced-0')));
}
async function edit(t,id,text){const s=q(id);if(id.startsWith('advanced-'))await advanced(t);await reveal(t,s);await t.click(s,12);await t.key('a',['control']);if(text)await t.insertText(text);else await t.key('Backspace');}
async function open(t,id,expandAdvanced=true){
 await t.click(q(`prov-item-${id}`));
 t.ok(`${id} 模型卡存在`,await t.waitFor(q('prov-model-expand-0')));
 if((await t.text(q('prov-model-expand-0'))).includes('展开')){await reveal(t,q('prov-model-expand-0'));await t.click(q('prov-model-expand-0'),20);}
 t.ok(`${id} 模型卡正文展开`,await t.waitFor(q('prov-model-body-0')));
 if(expandAdvanced)await advanced(t);
}
async function checkHeaders(t){
 const headers=await t.js(`(()=>{
  const label=document.querySelector('${q('prov-model-advanced-toggle-0')}');
  const item=label.closest('.ant-collapse-item'),collapse=item.parentElement;
  const items=[...collapse.children].filter(el=>el.classList.contains('ant-collapse-item'));
  const rows=items.map(el=>el.querySelector(':scope > .ant-collapse-header'));
  const style=el=>{const s=getComputedStyle(el);return{font:s.fontSize,weight:s.fontWeight,padding:s.padding,lineHeight:s.lineHeight};};
  return{sameLevel:collapse.classList.contains('ant-collapse')&&items[0]===item&&rows.every(Boolean),
   titles:rows.map(el=>el.textContent),styles:rows.map(style),states:rows.map(el=>el.getAttribute('aria-expanded'))};
 })()`);
 t.ok('高级参数位于同一个 Collapse 的首个同级 item',headers.sameLevel);
 t.ok('高级与思考、消息等选项为同级标题',headers.titles[0].includes('高级请求参数')&&headers.titles.some(x=>x.includes('思考与推理兼容'))&&headers.titles.some(x=>x.includes('消息、角色与工具')));
 t.ok('所有同级标题字号、字重、内边距和行高一致',headers.styles.every(style=>JSON.stringify(style)===JSON.stringify(headers.styles[0])));
 t.check('高级组默认收起',headers.states[0],'false');
 t.check('原思考兼容组默认展开状态不变',headers.states[headers.titles.findIndex(x=>x.includes('思考与推理兼容'))],'true');
 t.check('高级组默认不挂载编辑器',await t.count(q('advanced-0')),0);
}
async function checkLayout(t,narrow,theme){
 const layout=await t.js(`(()=>{
  const root=document.querySelector('${q('advanced-0')}');
  const sampling=root.querySelector('textarea[data-testid="advanced-0-samplingParams"]');
  const tiers=root.querySelector('textarea[data-testid="advanced-0-samplingParamsByThinkingLevel"]');
  const numeric=[...root.querySelectorAll('input')];
  const r=root.getBoundingClientRect(),a=sampling.getBoundingClientRect(),b=tiers.getBoundingClientRect();
  const [c,d,e]=numeric.map(el=>el.getBoundingClientRect());
  const label=getComputedStyle(sampling.closest('label').querySelector(':scope > span'));
  const neighbor=[...document.querySelector('${q('prov-model-body-0')}').querySelectorAll('div')].find(el=>el.textContent==='最大输出');
  if(!neighbor)throw new Error('样式探针未找到相邻的最大输出标签');
  const reference=getComputedStyle(neighbor);
  return{width:r.width,twoJson:Math.abs(a.top-b.top)<=2&&b.left>a.right&&Math.abs(a.width-b.width)<=2,
   oneJson:Math.abs(a.left-b.left)<=2&&b.top>=a.bottom&&Math.abs(a.width-b.width)<=2,
   twoNumeric:Math.abs(c.top-d.top)<=2&&d.left>c.right&&e.top>=c.bottom&&Math.abs(c.width-d.width)<=2,
   oneNumeric:Math.abs(c.left-d.left)<=2&&d.top>=c.bottom&&Math.abs(c.width-d.width)<=2,
   fits:document.documentElement.scrollWidth<=innerWidth+1&&root.scrollWidth<=root.clientWidth+1&&r.left>=0&&r.right<=innerWidth+1&&[sampling,tiers,...numeric].every(el=>{const x=el.getBoundingClientRect();return x.left>=r.left-1&&x.right<=r.right+1;}),
   labelsMatch:label.fontSize===reference.fontSize&&label.fontWeight===reference.fontWeight&&label.fontWeight==='600',
   helpSize:getComputedStyle(root.querySelector('p')).fontSize,
   codeSize:getComputedStyle(sampling).fontSize,
   filled:[sampling,tiers,...numeric].every(el=>el.classList.contains('ant-input-filled')),
   numericBackground:getComputedStyle(root.querySelector('${q('advanced-0-promptCache.short')}')).backgroundColor,
   jsonBackground:getComputedStyle(sampling).backgroundColor,
   adjacentBackground:getComputedStyle(document.querySelector('${q('prov-model-name-0')}')).backgroundColor};
 })()`);
 t.ok(`${theme} ${narrow?'窄':'宽'}屏 JSON 为${narrow?'单':'双'}列且字段对齐`,narrow?layout.oneJson:layout.twoJson);
 t.ok(`${theme} ${narrow?'窄':'宽'}屏数值为${narrow?'单':'双'}列且字段对齐`,narrow?layout.oneNumeric:layout.twoNumeric);
 t.ok(`${theme} 容器断点按实际卡片宽度生效`,narrow?layout.width<=560:layout.width>560);
 t.ok(`${theme} 高级字段与模型卡没有横向溢出`,layout.fits);
 t.ok(`${theme} 字段标签与邻近模型字段字号、600 字重一致`,layout.labelsMatch);
 t.check(`${theme} 帮助文字为设计约定 12px`,layout.helpSize,'12px');
 t.check(`${theme} JSON 代码文字为 12px`,layout.codeSize,'12px');
 t.ok(`${theme} JSON 与数值输入均使用 filled 风格`,layout.filled);
 t.checkColor(`${theme} 数值填充底色与相邻选项一致`,layout.numericBackground,layout.adjacentBackground);
 t.checkColor(`${theme} JSON 填充底色与相邻选项一致`,layout.jsonBackground,layout.adjacentBackground);
 t.check('高级正文不重复显示独立 h4 标题',await t.count(`${q('advanced-0')} h4`),0);
}
async function save(t){const n=(await t.events()).filter(x=>x==='save').length;await t.click(q('prov-save'));t.ok('模型配置写入',await t.waitUntil(`(window.__uiEvents??[]).filter(x=>x==='save').length>${n}`));return JSON.parse((await t.data()).savedModelsJson);}
async function shot(t,name){mkdirSync(evidence,{recursive:true});copyFileSync(await t.shot(name),join(evidence,`${name}.png`));}
export default async function(t){
 await t.waitFor(q('prov-item-openai'));await t.click(q('prov-item-openai'));
 const builtinAdvanced=await t.count(q('builtin-advanced'));t.check('不显示内置目录高级参数覆盖入口',builtinAdvanced,0);if(builtinAdvanced)return;
 if(process.env.MODEL_ADVANCED_COPY_ONLY==='1'){
  await t.waitFor(q('prov-item-googlefixture'));await open(t,'googlefixture');t.ok('Google仅显式字节覆盖才拒绝',(await t.text(q('advanced-0'))).includes('如有显式字节覆盖，请清除，否则会拒绝请求'));
  await open(t,'unsupported');t.ok('未知协议拒绝条件限定显式覆盖',(await t.text(q('advanced-0'))).includes('携带显式数量 / 字节覆盖会拒绝请求'));
  t.check('内置目录覆盖不再显示',await t.count(q('builtin-advanced')),0);await t.setTheme('light');await shot(t,'advanced-support-copy');return;
 }
 t.ok('供应商页加载',await t.waitFor(q('prov-item-relay')));t.check('读取不产生写入',(await t.events()).length,0);await open(t,'relay',false);
 await checkHeaders(t);
 const overviewSize=await t.resize(1420,1800);
 for(const theme of ['dark','light']){
  await t.setTheme(theme);await t.js(`document.querySelector('${q('prov-model-card-0')}').scrollIntoView({block:'start',behavior:'instant'})`);
  await shot(t,`advanced-default-collapsed-overview-${theme}`);
 }
 await t.resize(...overviewSize);await t.setTheme('dark');await reveal(t,advancedHeader);await t.click(advancedHeader,24);
 t.ok('真实鼠标打开后焦点位于可操作标题',await t.js(`document.activeElement===document.querySelector('${advancedHeader}')`));
 for(const key of ['Return','Space']){
  await t.key(key);t.ok(`${key} 键收起并更新 aria-expanded`,await t.waitUntil(`document.querySelector('${advancedHeader}').getAttribute('aria-expanded')==='false'`));
  t.check(`${key} 收起后高级编辑器卸载`,await t.count(q('advanced-0')),0);
  await t.key(key);t.ok(`${key} 键展开并更新 aria-expanded`,await t.waitUntil(`document.querySelector('${advancedHeader}').getAttribute('aria-expanded')==='true'`));
  t.ok(`${key} 展开后编辑器恢复`,await t.waitFor(q('advanced-0')));
 }
 await edit(t,'advanced-0-samplingParams','[1]');await t.click(q('prov-save'));t.ok('非法JSON就地拒绝保存',await t.waitForText(q('providers-settings'),'必须是 JSON 对象'));t.check('原草稿保留',await t.js(`document.querySelector('${q('advanced-0-samplingParams')}').value`),'[1]');t.check('非法配置不写盘',(await t.events()).filter(x=>x==='save').length,0);
 await advanced(t,false);t.check('非法草稿收起后编辑器确实卸载',await t.count(q('advanced-0')),0);await t.click(q('prov-save'));
 t.ok('非法 JSON 即使高级组收起仍阻止保存',await t.waitForText(q('providers-settings'),'必须是 JSON 对象'));
 t.check('收起非法草稿不能绕过配置写入校验',(await t.events()).filter(x=>x==='save').length,0);
 await advanced(t);t.check('重开高级组保留非法 JSON 原文',await t.js(`document.querySelector('${q('advanced-0-samplingParams')}').value`),'[1]');
 await edit(t,'advanced-0-samplingParams','{"top_p":0.8,"flag":false}');await edit(t,'advanced-0-samplingParamsByThinkingLevel','{"low":{"top_k":3},"high":{"top_k":9}}');await edit(t,'advanced-0-promptCache.short','0.5');await edit(t,'advanced-0-inputLimits.images.resize.maxWidth','512');
 await advanced(t,false);await advanced(t);
 t.check('有效 JSON 草稿收起重开保持原格式',await t.js(`document.querySelector('${q('advanced-0-samplingParams')}').value`),'{"top_p":0.8,"flag":false}');
 t.check('分档 JSON 草稿收起重开保持原格式',await t.js(`document.querySelector('${q('advanced-0-samplingParamsByThinkingLevel')}').value`),'{"low":{"top_k":3},"high":{"top_k":9}}');
 t.check('数值草稿收起重开不丢',await t.js(`document.querySelector('${q('advanced-0-promptCache.short')}').value`),'0.5');
 let saved=await save(t);t.check('有效模型API覆盖供应商API',saved.providers.relay.models[0].api,'openai-completions');t.check('四项高级参数落盘',saved.providers.relay.models[0].samplingParamsByThinkingLevel,{low:{top_k:3},high:{top_k:9}});t.check('小数TTL遵循SDK',saved.providers.relay.models[0].promptCache.short,0.5);t.check('未知嵌套字段保留',saved.providers.relay.models[0].inputLimits.images.resize.future,9);t.check('原分段价格保留',saved.providers.relay.models[0].cost.tiers[0].inputTokensAbove,100000);t.check('供应商未知字段保留',saved.providers.relay.futureProvider,{keep:1});
 await t.act('remount');await t.waitFor(q('prov-item-relay'));await open(t,'relay');t.check('重挂恢复采样JSON',JSON.parse(await t.js(`document.querySelector('${q('advanced-0-samplingParams')}').value`)),{top_p:0.8,flag:false});
 await edit(t,'advanced-0-promptCache.short','');saved=await save(t);t.ok('清除TTL只恢复继承',!Object.hasOwn(saved.providers.relay.models[0].promptCache??{},'short'));
 await t.act('failSave',true);await edit(t,'advanced-0-promptCache.long','60');await t.click(q('prov-save'));t.ok('磁盘失败明确反馈',await t.waitForText(q('providers-settings'),'夹具：磁盘不可写'));t.check('失败草稿保留',await t.js(`document.querySelector('${q('advanced-0-promptCache.long')}').value`),'60');await t.act('failSave',false);
 await t.act('partial',true);saved=await save(t);t.ok('写盘与刷新状态分开',await t.waitFor(q('prov-refresh-only')));const count=(await t.events()).filter(x=>x==='save').length;await t.click(q('prov-refresh-only'));t.ok('只重试刷新',await t.waitUntil(`(window.__uiEvents??[]).includes('refresh-only')`));t.check('刷新不重复写文件',(await t.events()).filter(x=>x==='save').length,count);await t.act('partial',false);
 await t.click(q('prov-item-openai'));t.check('内置高级覆盖入口已移除',await t.count(q('builtin-advanced')),0);
 t.check('已有内置覆盖原样保留',saved.providers.openai.modelOverrides['gpt-5'],{compat:{supportsFastMode:true},future:{keep:1}});t.check('原同ID替换仍留在models',saved.providers.openai.models[0].id,'replacement');
 await open(t,'googlefixture');t.check('Google图数可编辑',await t.js(`document.querySelector('${q('advanced-0-inputLimits.images.maxPerRequest')}').disabled`),false);t.check('Google最终bytes明确禁用',await t.js(`document.querySelector('${q('advanced-0-inputLimits.maxRequestBytes')}').disabled`),true);t.ok('Google给出清除指引',(await t.text(q('advanced-0'))).includes('Google SDK 不提供最终 HTTP JSON'));await t.js(`document.querySelector('${q('advanced-0-inputLimits.maxRequestBytes')}').scrollIntoView({block:'center'})`);await t.click(`[data-testid="advanced-0"] label:has([data-testid="advanced-0-inputLimits.maxRequestBytes"]) button`);saved=await save(t);t.ok('仅显式清除不支持的bytes',!Object.hasOwn(saved.providers.googlefixture.models[0].inputLimits,'maxRequestBytes')&&saved.providers.googlefixture.models[0].inputLimits.images.maxPerRequest===2);
 await open(t,'unsupported');t.check('未知协议不伪称图数已拦截',await t.js(`document.querySelector('${q('advanced-0-inputLimits.images.maxPerRequest')}').disabled`),true);t.ok('未知协议明确未支持且会拒绝',(await t.text(q('advanced-0'))).includes('携带显式数量 / 字节覆盖会拒绝请求'));
 await open(t,'relay');
 for(const theme of ['dark','light']){
  await t.setTheme(theme);await reveal(t,q('advanced-0'));await checkLayout(t,false,theme);await shot(t,`advanced-${theme}`);
  const size=await t.resize(1420,2400);await t.js(`document.querySelector('${q('prov-model-card-0')}').scrollIntoView({block:'start',behavior:'instant'})`);
  await shot(t,`advanced-open-full-model-card-${theme}`);await t.resize(...size);
 }
 const old=await t.resize(780,740);
 for(const theme of ['light','dark']){
  await t.setTheme(theme);await t.js(`document.querySelector('${q('advanced-0')}').scrollIntoView({block:'start',behavior:'instant'})`);
  await checkLayout(t,true,theme);
  const geometry=await t.js(`(()=>{const r=document.querySelector('${q('advanced-0-samplingParams')}').getBoundingClientRect();return{left:r.left,right:r.right,width:r.width,screen:innerWidth}})()`);
  t.ok('窄屏高级参数不溢出',geometry.left>=0&&geometry.right<=geometry.screen&&geometry.width>150);await shot(t,`advanced-narrow-${theme}`);
 }
 await t.resize(...old);
}
