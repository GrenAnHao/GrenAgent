(() => {
  const target=/*ACTIVETARGET*/null;
  localStorage.setItem('gren.lastOpen',JSON.stringify({workspace:target.workspace,sessionPath:target.sessionPath}));
  const marks=window.__benchMarks={}, now=()=>Math.round(performance.timeOrigin+performance.now());
  const mark=k=>{if(marks[k]==null)marks[k]=now()};
  mark('html');
  const scan=()=>{
    const splash=document.getElementById('boot-splash');
    if(splash)mark('splashDom');
    if(splash?.classList.contains('is-leaving'))mark('splashLeaving');
    if(marks.splashDom && !splash)mark('splashRemoved');
    if(!marks.editor || !marks.active) {
      if(document.querySelector('[data-testid="composer-surface"] [contenteditable="true"]'))mark('editor');
      if(document.querySelector('#root')?.textContent.includes('ZZ-RESTORED-ACTIVE-MESSAGE'))mark('active');
    }
  };
  new MutationObserver(scan).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
  addEventListener('DOMContentLoaded',()=>{mark('domLoaded');scan()});
})();
