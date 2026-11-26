// Run both snapshots in the same live renderer. Compare CSS pixel rectangles and metrics
// without rounding to device pixels, which would hide a layout-unit shift at 150% DPI.
export async function compareThemeGeometry(t, label, scope, phase, firstLightPaint = []) {
  const result = await t.js(`(() => {
    const scope = document.querySelector(${JSON.stringify(scope)});
    const styles = ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','borderRadius','padding','gap',
      'borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','borderStyle'];
    const rows = {}, nodes = [];
    function visit(el, path) {
      const r = el.getBoundingClientRect();
      if ((el instanceof HTMLElement || el instanceof SVGSVGElement) && r.width && r.height && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth &&
          el.checkVisibility({opacityProperty:true, visibilityProperty:true})) {
        const s = getComputedStyle(el), bar = getComputedStyle(el, '::-webkit-scrollbar');
        rows[path] = {
          name: el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.tagName,
          box: [r.x,r.y,r.width,r.height],
          metrics: Object.fromEntries(styles.map(k => [k,s[k]])),
          scroll: [el.scrollTop,el.scrollLeft,el.clientWidth,el.clientHeight,bar.width,bar.height],
        };
        nodes.push([el,path]);
      }
      Array.from(el.children).forEach((child,i) => visit(child, path+'.'+i));
    }
    visit(scope,'root');
    if (${phase === 'before'}) {
      const audit = { rows, frames:0, motion:[], firstLight:null };
      window.__themeGeometryAudit = audit;
      const observer = new MutationObserver(() => {
        observer.disconnect();
        const deadline = performance.now()+175;
        function sample() {
          audit.frames++;
          if (!audit.firstLight && ${firstLightPaint.length} && getComputedStyle(document.documentElement).getPropertyValue('--gren-content-bg').trim().toLowerCase()==='#f8f9f8') {
            audit.firstLight = ${JSON.stringify(firstLightPaint)}.map(([selector,property,expected]) => {
              const value = getComputedStyle(document.querySelector(selector)).getPropertyValue(property)
              return [selector,property,value,expected]
            });
          }
          for (const [el,path] of nodes) {
            if (!el.isConnected) continue; // Remounts are compared by DOM path in the final snapshot.
            const r=el.getBoundingClientRect(), box=[r.x,r.y,r.width,r.height], old=rows[path];
            if (audit.motion.length<8 && box.some((v,i)=>Math.abs(v-old.box[i])>0.0001))
              audit.motion.push([old.name,old.box,box]);
          }
          if (performance.now()<deadline) requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      });
      observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
      return {count:nodes.length};
    }
    const {rows:baseline,frames,motion,firstLight} = window.__themeGeometryAudit, differences = [];
    for (const path of new Set([...Object.keys(baseline), ...Object.keys(rows)])) {
      const a = baseline[path], b = rows[path];
      if (!a || !b || a.name !== b.name) { differences.push({ path, was:a?.name, now:b?.name }); continue; }
      const changed = {};
      for (const key in a.metrics) if (a.metrics[key] !== b.metrics[key]) changed[key] = [a.metrics[key],b.metrics[key]];
      if (a.box.some((px,i) => Math.abs(px-b.box[i]) > 0.0001)) changed.rect = [a.box,b.box];
      if (JSON.stringify(a.scroll) !== JSON.stringify(b.scroll)) changed.scroll = [a.scroll,b.scroll];
      if (Object.keys(changed).length) differences.push({ path, name:a.name, ...changed });
    }
    delete window.__themeGeometryAudit;
    return {count:nodes.length, frames, motion, firstLight, total:differences.length, differences:differences.slice(0,12)};
  })()`)
  if (phase !== 'before') {
    t.info(`${label}：逐元素对照可见部件`, result.count)
    t.ok(`${label}：实际切换过程有渲染帧可供比较`,result.frames>0)
    t.check(`${label}：变色过程逐帧位置不动`,result.motion,[])
    if (firstLightPaint.length) t.check(`${label}：新色板首帧文字与图标不残留旧主题前景`,
      result.firstLight?.filter(([, ,actual,expected])=>actual!==expected),[])
    t.check(`${label}：明暗切换零位移，字号、边框、圆角、间距、滚动条和滚动位置相同`, [result.total,result.differences], [0,[]])
  }
}

export async function checkPageHeading(t, label, selector) {
  const heading = await t.style(selector, ['font-size','font-weight','letter-spacing','line-height'])
  t.check(`${label} 标题为 18px / 600 / 1.3 / −0.02em`, heading && [
    heading.fontSize, heading.fontWeight, heading.lineHeight, heading.letterSpacing
  ], ['18px','600','23.4px','-0.36px'])
}
