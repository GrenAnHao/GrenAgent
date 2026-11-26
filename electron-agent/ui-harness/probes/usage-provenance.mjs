import { inspectProjects, inspectRing, inspectSessions, inspectTrend } from '../usageInspection.mjs';

const region = (name) => `section[aria-label="${name}"]`;
const trend = region('每日趋势'), models = region('按模型占比'), projects = region('按项目对比');
const summary = '[data-testid="usage-provenance-summary"]', kpis = '[data-testid="usage-kpis"]', token = '[data-testid="usage-token-total"]';
const day = '[data-usage-day="2026-11-25"]', dayTip='[data-usage-trend-tip]';
const q = JSON.stringify;
const normalize = s=>s.replace(/[,\s]/g,'');
async function reveal(t,s) {
  await t.js(`document.querySelector(${q(s)})?.scrollIntoView({block:'nearest',inline:'nearest'})`);
  await t.sleep(100);
}
async function click(t,s) {
  await reveal(t,s);
  await t.clickReady(s);
}
async function setMetric(t,section,cost) {
  const s=section+' button:nth-of-type('+(cost?2:1)+')';
  await click(t,s);
  t.ok('切换后只有选中指标被按下：'+section+' / '+(cost?'费用':'Token'),await t.waitUntil(`document.querySelector(${q(s)})?.getAttribute('aria-pressed')==='true'`));
}
async function pointFor(t,s,method) {
  await reveal(t,s);
  const coords = await t.js(`(() => {const e=document.querySelector(${q(s)});if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
  if(coords) await t[method](coords);
}
async function chooseProject(t,label) {
  const select = '[aria-label="筛选项目"]';
  await reveal(t,select);
  // Ant may use an invisible input for its combobox. Click its visible trigger, then a real option.
  const p = await t.js(`(() => {const el=document.querySelector(${q(select)}); const r=(el?.closest('.ant-select') ?? el)?.getBoundingClientRect(); return r ? {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} : null})()`);
  t.ok('有可操作的项目过滤器',!!p); if(!p)return;
  await t.click(p);
  const opt = `.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="${label}"]`;
  t.ok('项目下拉列出 '+label,await t.waitFor(opt));
  if(await t.count(opt))await click(t,opt);
}
async function range(t,label) {
  const point = await t.js(`(()=>{const el=Array.from(document.querySelectorAll('label,button')).find(e=>e.innerText.trim()===${q(label)});if(!el)return null;el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  t.ok('时间范围可用：'+label,!!point); if(point)await t.click(point);
}
async function surface(t) {
  return t.js(`[...document.querySelectorAll('section[aria-label], [data-testid="usage-kpis"]')].map(e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return [e.getAttribute('aria-label'),r.width,r.height,s.borderRadius,s.borderTopWidth,s.fontSize]})`);
}
async function percentages(t) {
  return t.js(`[...document.querySelectorAll('[data-usage-percent]')].map(e=>parseInt(e.textContent,10)).reduce((a,b)=>a+b,0)`);
}
async function readColors(t) {
  return t.js(`(() => {
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const read=(s,property)=>{const el=document.querySelector(s); if(!el)return null;
      const css=getComputedStyle(el);ctx.clearRect(0,0,1,1);ctx.fillStyle=css[property];ctx.fillRect(0,0,1,1);
      return [...ctx.getImageData(0,0,1,1).data];};
    return {bar:read('.usage-trend-bar','backgroundColor'),grid:read('.usage-trend-grid i','borderTopColor'),
      axes:read('.usage-trend-scale','color'),surface:read('section[aria-label="每日趋势"]','backgroundColor'),
      tip:read('[data-usage-trend-tip]','backgroundColor'),tipText:read('[data-usage-trend-tip]','color'),
      lastBar:read('[data-usage-day="2026-11-25"]','backgroundColor')};
  })()`);
}
const isSage = c => c && c[1]>c[0]+4 && c[1]>c[2];
function contrast(a,b) {
  if(!a||!b)return 0;
  const l=c=>c.slice(0,3).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4)
    .reduce((s,n,i)=>s+n*[.2126,.7152,.0722][i],0);
  const x=l(a),y=l(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
export default async function(t) {
  t.ok('真实用量面板加载',await t.waitFor(summary));
  t.ok('全部报表有三张可独立操作的图表',await t.count(trend)+await t.count(models)+await t.count(projects)===3);
  if(!await t.count(trend))return;
  t.ok('初始加载时未限定项目与日期', (await t.events()).includes('report:all:*'));
  const body=await t.text('body');
  t.ok('五张指标卡小字均已呈现',await t.count(kpis+' [data-testid="usage-kpi-detail"]')===5);
  t.ok('会话/消息使用千分位分隔',body.includes('111,995') && body.includes('1,463'));
  t.ok('非零的小额目录估算显示为0.2%而不是零',(await t.text(kpis)).includes('目录估算占比 0.2%'));
  t.ok('五张卡片采用等宽数字',await t.js(`getComputedStyle(document.querySelector(${q(token)})).fontVariantNumeric.includes('tabular-nums')`));
  t.check('超十亿 Token 的概览单位',await t.text(token),'27.00B');
  await pointFor(t,token,'hover');
  t.ok('悬停显示未舍入的 26,992,500,000 tokens',await t.waitForText('.ant-tooltip:not(.ant-tooltip-hidden)','26,992,500,000'));
  await t.mouse(1,1);
  t.ok('助手/预热费用和来源在摘要中可读', ['助手','预热','供应商','目录','未知'].every(s=>body.includes(s)));
  const info='[aria-label="口径说明"]';
  t.ok('统计口径不再占用第三行',!(await t.text(summary)).includes('外部导入历史'));
  await pointFor(t,info,'hover');
  t.ok('悬停口径读取外部历史与压缩边界',await t.waitUntil(`Array.from(document.querySelectorAll('.ant-tooltip:not(.ant-tooltip-hidden)')).some(e=>e.textContent.includes('外部')&&e.textContent.includes('压缩'))`));
  await t.mouse(1,1);
  t.ok('最近会话在展示层提取了 JSON 内真实标题',body.includes('登录状态颜色')&&!body.includes('isNewTopic'));
  t.ok('模型调用明细保留真实响应模型、未报告及零价',body.includes('sol-service-rev3')&&!body.includes('响应：未报告')&&body.includes('$0.00'));
  t.check('不恢复已撤下的预热调用明细表',await t.count('[data-testid="warming-usage-table"]'),0);
  const names=(await t.data()).projectNames;
  const labels=await t.text(projects);
  t.ok('所有非空项目（含全局会话）都有完整可读的名称',names.every(x=>labels.includes(x)) && !labels.includes('登录状态颜色'));
  t.check('模型长尾聚合后最多七行',await t.count('[data-usage-model]'),7);
  t.ok('只出现一个同名模型与一个 Others',await t.js(`[...document.querySelectorAll('[data-usage-model]')].filter(e=>e.dataset.usageModel.trim().toLowerCase()==='gpt-6.1-sol').length===1 && document.querySelector('[data-usage-model]:last-child')?.textContent.includes('其他')`));
  t.check('Token 占比总和',await percentages(t),100);
  t.ok('跨渠道的同名模型在合并后占全量 37%', (await t.text('[data-usage-model="gpt-6.1-sol"]')).includes('37%'));
  t.ok('项目名完整显示、Token 和费用列逐项右对齐',await t.js(`(()=>{const rows=[...document.querySelectorAll('[data-usage-project]')];const rights=rows[0].cells;return rows.every(r=>r.cells[0].scrollWidth<=r.cells[0].clientWidth+1&&[2,3].every(i=>getComputedStyle(r.cells[i]).textAlign==='right'&&r.cells[i].getBoundingClientRect().right===rights[i].getBoundingClientRect().right))})()`));
  const centerBefore=await t.text('[data-usage-donut-total]');
  t.ok('环中央显示总 Token',centerBefore.includes('B'));
  const geometry=await surface(t);
  const dark=await readColors(t);
  t.ok('暗色柱体使用鼠尾草色',isSage(dark.bar));
  t.ok('暗色坐标轴文字在卡片上清晰可读',contrast(dark.surface,dark.axes)>=4.5);
  await t.shot('usage-analytics-dark');
  await inspectTrend(t,'dark');
  await inspectRing(t,'dark');
  await inspectProjects(t);
  await pointFor(t,day,'hover');
  t.ok('趋势柱能显示当天四项信息', await t.waitUntil(`(() => {const e=document.querySelector(${q(dayTip)});return e&&['Token','费用','调用','缓存'].every(x=>e.textContent.includes(x))})()`));
  const tipContent = normalize((await t.text(dayTip))||'');
  t.ok('趋势 Tooltip 当日缓存命中率为 90%', tipContent.includes('90%'));
  const {lastDay}=await t.data();
  t.ok('悬停日的信息与该日记录逐项一致',tipContent.includes(lastDay.date)&&tipContent.includes(String(lastDay.tokens))
    &&tipContent.includes(String(lastDay.messages)+'次')&&tipContent.includes('$'+lastDay.recordedCost.toFixed(2)));
  const darkHover=await readColors(t);
  t.ok('鼠标指向日柱时加深品牌色',JSON.stringify(darkHover.lastBar)!==JSON.stringify(dark.lastBar));
  t.ok('暗色趋势 Tooltip 对比度',contrast(darkHover.tip,darkHover.tipText)>=4.5);
  await t.mouse(1,1);
  await t.setTheme('light'); await t.sleep(350);
  t.check('同窗同数据切换明暗后，各卡宽高/边框/字号不变',JSON.stringify(await surface(t)),JSON.stringify(geometry));
  const light=await readColors(t);
  t.ok('浅色柱体也为鼠尾草绿，明暗按各自色阶映射',isSage(light.bar) && JSON.stringify(light.bar)!==JSON.stringify(dark.bar));
  t.ok('坐标轴/卡片/网格线均随主题映射', ['axes','surface','grid'].every(k=>JSON.stringify(dark[k])!==JSON.stringify(light[k])));
  t.ok('浅色坐标轴文字在卡片上清晰可读',contrast(light.surface,light.axes)>=4.5);
  await t.shot('usage-analytics-light');
  await inspectTrend(t,'light');
  await inspectRing(t,'light');
  await inspectProjects(t);
  await pointFor(t,day,'hover');
  t.ok('浅色也可读取当天的费用详情',await t.waitFor(dayTip));
  const lightHover=await readColors(t);
  t.ok('浅色趋势 Tooltip 使用浅色表面，文字具备足够对比度',contrast(lightHover.tip,lightHover.tipText)>=4.5 && JSON.stringify(darkHover.tip)!==JSON.stringify(lightHover.tip));
  await t.shot('usage-analytics-trend-tooltip');
  await t.mouse(1,1);
  await setMetric(t,models,true);
  t.check('费用百分比总和',await percentages(t),100);
  t.ok('按费用重排后，最贵模型不同于占 Token 最高的模型', (await t.text('[data-usage-model]')).includes('gpt-6.2-astra'));
  t.ok('环内改为全部已记录费用口径（含预热）',normalize(await t.text('[data-usage-donut-total]')).includes('$1882'));
  await setMetric(t,projects,true);
  t.ok('费用排名保留 0 Token 的真实预热费，但不显示零费空项目',await t.waitForText('.usage-project-wrap','仅预热') && !(await t.text('.usage-project-wrap')).includes('s118'));
  t.ok('最贵项目按费用排序，同时仍可看 Token', (await t.text('[data-usage-project]')).includes('Skyline Observatory')&&(await t.text('[data-usage-project]')).includes('$'));
  t.ok('模型与项目两张图切换不改变趋势指标',await t.js(`document.querySelector(${q(trend+' button[aria-pressed="true"]')})?.textContent==='Token'`));
  await setMetric(t,trend,true);
  await pointFor(t,day,'hover');
  t.ok('切至费用，日趋势详情仍有 Token 与次数',await t.waitUntil(`document.querySelector(${q(dayTip)})?.textContent.includes('Token')`));
  await t.mouse(1,1);
  await t.shot('usage-analytics-cost');
  await range(t,'近 30 天');
  t.ok('近30天查询及卡片联动',(await t.events()).includes('report:30d:*') && normalize(await t.text(kpis)).includes('86120'));
  await range(t,'近 7 天');
  t.ok('近7天查询及趋势日数联动',(await t.events()).includes('report:7d:*') && await t.count('[data-usage-day]')===7);
  await chooseProject(t,'GrenAgent');
  t.ok('项目过滤保留已选日期', (await t.events()).includes('report:7d:/work/GrenAgent'));
  t.ok('表内同时只剩选中的项目，指标也随之改变',await t.count('[data-usage-project]')===1 && (await t.text(kpis)).includes('11,205'));
  t.ok('选择费用后连续更换日期和项目仍显示原先三个视角',await t.js(`[...document.querySelectorAll('.usage-metric-toggle button[aria-pressed="true"]')].map(e=>e.textContent).join('/') === '费用 ($)/费用 ($)/费用 ($)'`));
  await chooseProject(t,'Archived console');
  t.ok('没有活动记录的项目仍可选择',(await t.events()).includes('report:7d:/work/archive'));
  t.ok('空报表不保留柱子/扇区/项目行', (await t.count('[data-usage-day], [data-usage-model], [data-usage-project]'))===0);
  await range(t,'全部时间');
  t.ok('延长日期后可在同一项目恢复有数据', (await t.events()).includes('report:all:/work/archive') && await t.count('[data-usage-project]')===1);
  await chooseProject(t,'全部项目');
  await inspectSessions(t);
  const calls='section[aria-label="模型调用明细"]';
  await reveal(t,calls+' header');
  t.ok('调用条数、单行响应差异和每页20条',await t.count(calls+' tbody tr')===20 && (await t.text(calls+' header')).includes('25') && (await t.text(calls+' tbody')).includes('gpt-6.1-sol → sol-service-rev3') && !(await t.text(calls+' tbody')).includes('目录估算'));
  const small=calls+' [aria-label="按本地目录单价估算"]';
  await reveal(t,small);await t.hover(small);
  t.ok('费用旁的小图标解释目录估算',await t.waitForText('.ant-tooltip:not(.ant-tooltip-hidden)','按本地目录单价估算'));
  await t.mouse(1,1);
  await click(t,calls+' .ant-pagination-item-2');
  t.check('末页只剩5条',await t.count(calls+' tbody tr'),5);
  async function pickCall(label,value) {
    const el=calls+' [aria-label="'+label+'"]';
    await reveal(t,el);
    const xy=await t.js(`(()=>{const b=document.querySelector(${q(el)}).closest('.ant-select').getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)}})()`);
    await t.click(xy);
    await click(t,'.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="'+value+'"]');
  }
  await pickCall('按供应商筛选调用','Relay'); await pickCall('按请求模型筛选调用','deepseek-flash');
  t.ok('供应商与模型联合筛选，返回第一页，同行不重复模型名',await t.count(calls+' tbody tr')===20 && (await t.text(calls+' header')).includes('22') && await t.text(calls+' tbody tr td:nth-child(3)')==='deepseek-flash');
  await t.js(`document.querySelector(${q(calls)}).scrollIntoView({block:'center'})`);
  await t.shot('seal-calls');
  await pickCall('按供应商筛选调用','全部供应商'); await pickCall('按请求模型筛选调用','全部模型');
  await t.resize(390,825); await t.sleep(180);
  await inspectTrend(t,'light',true);
  await t.resize(620,825); await t.sleep(250);
  t.ok('620px 顶栏和图表不撑破页面宽度',await t.js(`document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('section[aria-label]')].every(e=> e.getBoundingClientRect().right<=innerWidth+.5)`));
  await t.shot('usage-analytics-narrow');
  const scrollRoot='section[aria-label="用量统计"]';
  await t.wheel(scrollRoot,2200); await t.sleep(200);
  t.ok('窄窗可以实际滚动到调用明细',await t.js(`[...document.querySelectorAll('td')].some(e=>e.textContent.includes('sol-service-rev3') && e.getBoundingClientRect().bottom<=innerHeight && e.getBoundingClientRect().bottom>0)`));
  await t.shot('usage-analytics-details-narrow');
  await t.wheel(scrollRoot,-2200);await t.sleep(200);
  await pointFor(t,info,'hover'); await t.mouse(1,1);
  await t.act('fail');
  await range(t,'近 7 天');
  t.ok('新筛选发生读取错误时可见失败原因',await t.waitForText('[role="alert"]','fixture report failure'));
  await t.act('recover');
  const retry=await t.js(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.innerText.trim()==='重试');if(!b)return null;const r=b.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  if(retry)await t.click(retry);
  t.ok('重试继续原筛选条件',await t.waitUntil(`!!document.querySelector('${kpis}') && !document.querySelector('[role="alert"]') && document.querySelector('${kpis}').textContent.includes('24,900')`));
}
