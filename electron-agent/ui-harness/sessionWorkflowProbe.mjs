export async function clickText(t,text,selector='button'){
 const p=await t.js(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.textContent.trim()===${JSON.stringify(text)}&&x.checkVisibility({visibilityProperty:true}));if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);if(!p)throw Error('Missing '+text);await t.click(p);
}
export async function themesAndNarrow(t,name){await t.js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await t.shot(name+'-dark');await t.setTheme('light');await t.shot(name+'-light');await t.resize(520,780);t.ok('窄屏无横向溢出',await t.js('document.documentElement.scrollWidth <= innerWidth'));await t.shot(name+'-narrow');}
