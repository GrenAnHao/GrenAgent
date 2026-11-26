const q = JSON.stringify;
const tip = '[data-usage-trend-tip]';
const recent = 'section[aria-label="最近会话"]';
async function reveal(t, selector) {
  await t.js(`document.querySelector(${q(selector)})?.scrollIntoView({block:'nearest',inline:'nearest'})`);
}
async function click(t, selector) {
  await reveal(t, selector);
  await t.clickReady(selector);
}

export async function inspectTrend(t, mode, narrow = false) {
  const plot = '.usage-trend-plot';
  await t.js(`document.querySelector('${plot}').scrollIntoView({block:'center'})`);
  const days=await t.js(`(()=>{const bars=[...document.querySelectorAll('[data-usage-day]')];return [bars[0],bars[Math.floor(bars.length/2)],bars.at(-1),bars.reduce((a,b)=>a.offsetHeight>b.offsetHeight?a:b)].map(b=>b.dataset.usageDay)})()`);
  for (const index of [0,1,2,3,1,0,3]) {
    const day=days[index];
    const point=await t.js(`(()=>{const b=document.querySelector('[data-usage-day="${day}"]').getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)}})()`);
    await t.mouse(point.x,point.y);
    const geometry=await t.js(`(()=>{
      const bar=document.querySelector('[data-usage-day="${day}"]'), tip=document.querySelector('[data-usage-trend-tip]'); if(!tip)return null;
      const b=bar.getBoundingClientRect(), f=tip.getBoundingClientRect(), c=bar.closest('section').getBoundingClientRect(), css=getComputedStyle(tip);
      const near=[...bar.parentElement.querySelectorAll('[data-usage-day]')].map(e=>e.getBoundingClientRect()).filter(r=>r.left<f.right && r.right>f.left);
      return {clear:near.every(r=>r.top-f.bottom>=9.9) && Math.abs(Math.min(...near.map(r=>r.top))-f.bottom-10)<.6,
        center:Math.abs(f.left-Math.max(c.left+2,Math.min((b.left+b.right-f.width)/2,c.right-2-f.width)))<1,
        date:tip.querySelector('strong').textContent, top:f.top, inert:css.pointerEvents==='none', color:css.backgroundColor, active:bar.dataset.active,
        inside:f.left>=c.left && f.right<=c.right && tip.parentElement===document.body, line:[...tip.querySelectorAll('dd')].every(e=>getComputedStyle(e).whiteSpace==='nowrap')};
    })()`);
    t.ok(mode+' '+index+' 气泡居中钳制、在覆盖范围内最高柱上方 10px，日期无跨天副标题',geometry && geometry.clear && geometry.center && geometry.inside && geometry.top>=0 && geometry.inert && geometry.active==='true' && geometry.line && geometry.date.startsWith(day+' 周'));
    if (index===3 && geometry) {t.check('实色表面',geometry.color,mode==='dark'?'rgb(31, 34, 32)':'rgb(255, 255, 255)'); await t.shot('seal-trend-'+(narrow?'narrow':mode));}
  }
  await t.mouse(1,1);
  t.check(mode+' 离开绘图区后清除提示与高亮带',await t.count(tip+', .usage-trend-band'),0);
  await t.js('delete window.__usageTip');
}

export async function inspectRing(t, mode) {
  await reveal(t,'.usage-donut');
  const ring = await t.js(`(() => {
    const svg=document.querySelector('.usage-donut svg'), rect=svg.getBoundingClientRect();
    const at=(x,y)=>({x:Math.round(rect.left+x*rect.width/100),y:Math.round(rect.top+y*rect.height/100)});
    return {center:at(50,50), outside:at(-3,50), slices:[...svg.querySelectorAll('path[data-usage-slice]')].slice(0,2).map(p=>{
      const m=p.getPointAtLength(p.getTotalLength()/2);
      const r=Math.hypot(m.x-50,m.y-50), edge=(Number(p.getAttribute('stroke-width'))/2-1)/r;
      return {key:p.dataset.usageSlice, inner:at(50+(m.x-50)*(1-edge),50+(m.y-50)*(1-edge)), outer:at(50+(m.x-50)*(1+edge),50+(m.y-50)*(1+edge))};
    })};
  })()`);
  for (const slice of ring.slices) {
    for (const point of [slice.inner,slice.outer,slice.inner]) {
      await t.mouse(point.x,point.y);
      const inspection=await t.js(`(()=>{
        const row=document.querySelector('[data-usage-model][data-active]'), center=document.querySelector('.usage-donut-center');
        return row && {name:row.dataset.usageModel, text:center.innerText, value:row.querySelector('.usage-model-value').textContent,
          pct:row.querySelector('[data-usage-percent]').textContent, center:center.dataset.usageActiveModel,
          total:!!center.querySelector('[data-usage-donut-total]'), overlay:!!document.querySelector('.usage-model [role=tooltip]'),
          bg:getComputedStyle(row).backgroundColor};
      })()`);
      t.ok(mode+' 扇区内外缘：中心只显示命中的模型、数值及占比，图例同步',inspection && 'model:'+inspection.name===slice.key &&
        inspection.center===inspection.name && inspection.text.includes(inspection.value) && inspection.text.includes(inspection.pct) &&
        !inspection.total && !inspection.overlay && inspection.bg!=='rgba(0, 0, 0, 0)');
    }
    if (slice===ring.slices[0]) await t.shot('usage-ring-'+mode);
    for (const point of [ring.center,ring.outside]) {
      await t.mouse(point.x,point.y);
      t.ok(mode+' 圆心空洞和外侧恢复汇总，不残留图例高亮',await t.count('[data-usage-donut-total]')===1 && !await t.count('[data-usage-model][data-active]'));
    }
  }
  await t.hover('[data-usage-model="deepseek-v4.1-flash"] .usage-model-name');
  t.ok('长模型名分两行，完整可见',await t.js(`(()=>{const e=document.querySelector('.usage-center-name');return e?.textContent==='deepseek-v4.1-flash' && e.scrollHeight<=e.clientHeight+1 && e.clientHeight>13;})()`));
  await t.shot('seal-ring-'+mode);
  const value='[data-usage-model] .usage-model-value';
  await t.hover(value);
  const hint='.usage-chart-hint:not(.ant-tooltip-hidden)';
  t.ok(mode+' 图例旁的精确值也使用同一实色浮层',await t.waitForText(hint,'tokens') && await t.js(`(()=>{const root=document.querySelector('${hint}'), body=root.querySelector('.usage-chart-hint-body');return getComputedStyle(root).zIndex==='50' && getComputedStyle(root).pointerEvents==='none' && getComputedStyle(body).backgroundColor===${q(mode==='dark'?'rgb(31, 34, 32)':'rgb(255, 255, 255)')};})()`));
  await t.mouse(1,1);
}

export async function inspectProjects(t) {
  const list='.usage-project-wrap';
  await reveal(t,list);
  t.ok('模型与项目的固定双卡上下边缘相同',await t.js(`(()=>{
    const [a,b]=[...document.querySelectorAll('.usage-chart-pair>section')].map(e=>e.getBoundingClientRect());
    return a.top===b.top && a.bottom===b.bottom && a.height===248;})()`));
  const body=list+' tbody', names=await t.text(body);
  t.ok('每屏六条完整单行项目',await t.js(`(()=>{const w=document.querySelector('${body}'),b=w.getBoundingClientRect();return [...w.rows].filter(r=>r.getBoundingClientRect().bottom<=b.bottom+.2).length===6})()`));
  t.ok('Token 排名排除 0 Token 和纯预热项目',!names.includes('s118') && !names.includes('仅预热'));
  const top=await t.js(`document.querySelector('${list} thead').getBoundingClientRect().top`);
  await t.wheel(body,400);
  t.ok('滚动停在完整行，表头不参与滚动，费用与滑块留出 10px',await t.waitUntil(`(()=>{const w=document.querySelector('${body}'),h=w.previousElementSibling.getBoundingClientRect(), b=w.getBoundingClientRect(), rows=[...w.rows].map(r=>r.getBoundingClientRect()),r=w.rows[0].lastElementChild.getBoundingClientRect();
    return w.scrollTop>0 && Math.abs(h.top-${top})<.5 && h.bottom<=b.top+.2 && rows.some(r=>Math.abs(r.top-b.top)<.6) && b.left+w.clientWidth-r.right>=9.9;})()`));
  await t.shot('seal-project-scroll-'+await t.js('document.documentElement.dataset.theme'));
  await t.wheel(body,-400);
}

export async function inspectSessions(t) {
  const body=recent+' [data-usage-session]', empty=recent+' [data-usage-session="recent-1"]',
    old=recent+' [data-usage-session="recent-22"]', needle=recent+' input[aria-label="搜索会话名称"]',
    checkbox=recent+' label.ant-checkbox-wrapper';
  await reveal(t,recent+' thead');
  t.check('默认每页最多十五条',await t.count(body),15);
  t.ok('默认勾选过滤，不显示空行；标题和项目徽章分开',await t.js(`document.querySelector('${recent} input[type=checkbox]').checked && !document.querySelector('${empty}') && [...document.querySelector('[data-usage-session="recent-0"] td div').children].map(e=>e.textContent).join('|')==='GrenAgent|登录状态颜色'`));
  await click(t,checkbox);
  t.ok('可查看空会话，零费用使用淡色 $0.00',await t.js(`(()=>{const e=document.querySelector('${empty} td:last-child'); return e?.textContent==='$0.00' && getComputedStyle(e).color!==getComputedStyle(e.parentElement).color})()`));
  await click(t,checkbox);
  await click(t,recent+' .ant-pagination-item-2');
  t.ok('页二展示更早的非空会话而不是重复第一页',await t.count(old)===1 && !await t.count('[data-usage-session="recent-0"]'));
  await click(t,recent+' [data-usage-sort="cost"]');
  t.ok('费用降序跨页返回最贵的 $9.25 会话到第一行',(await t.text(body)).includes('$9.25') && await t.js(`document.querySelector('${body}').dataset.usageSession==='recent-22'`));
  await click(t,recent+' [data-usage-sort="cost"]');
  t.ok('费用升序：非零小额保留四位',(await t.text(body)).includes('$0.0123'));
  for (const [key, id] of [['tokens','recent-0'],['time','recent-0']]) {
    await click(t,recent+' [data-usage-sort="'+key+'"]');
    t.ok(key+' 可降序排序',await t.js(`document.querySelector('${body}').dataset.usageSession==='${id}' && document.querySelector('[data-usage-sort="${key}"]').parentElement.getAttribute('aria-sort')==='descending'`));
    await click(t,recent+' [data-usage-sort="'+key+'"]');
    t.ok(key+' 可升序排序',await t.js(`document.querySelector('[data-usage-sort="${key}"]').parentElement.getAttribute('aria-sort')==='ascending'`));
  }
  await click(t,needle); await t.insertText('昂贵');
  t.ok('按名称搜索返回唯一结果，无多余分页',await t.count(body)===1 && await t.count(old)===1 && !await t.count(recent+' .ant-pagination'));
  await t.key('a',['control']); await t.insertText('没有这条');
  t.ok('无匹配显示明确空态',await t.waitForText(recent,'没有匹配的会话'));
  await t.key('a',['control']); await t.key('Backspace');
  await click(t,recent+' [data-usage-sort="cost"]');
  await reveal(t,recent+' thead'); await t.shot('usage-session-table');
}
