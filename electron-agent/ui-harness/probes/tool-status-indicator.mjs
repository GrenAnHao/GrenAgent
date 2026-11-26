const tile = '[data-testid="live-indicator"] > :first-child';
const busy = tile + ' [aria-busy="true"]';
const network = busy + ' svg';

export default async function (t) {
  await t.resize(420, 190);
  await t.waitFor(busy);
  const box = await t.rect(tile);
  t.check('运行中外框为 24 × 24 px', [box.w, box.h], [24, 24]);
  const svg = await t.rect(network);
  t.check('网络图形为 16 × 16 px', [svg.w, svg.h], [16, 16]);
  t.check('三层各三个节点之间有十八条连线，不是普通转圈', await t.count(network + ' line'), 18);
  t.ok('网络动画在播放', await t.js(`(async () => {
    const el = document.querySelector('${busy}');
    const anim = el.getAnimations({ subtree: true }).find(a => a.playState === 'running' && a.effect.getTiming().iterations === Infinity);
    if (!anim) return false;
    const before = anim.currentTime;
    await new Promise(resolve => setTimeout(resolve, 90));
    return anim.currentTime > before;
  })()`));
  await t.shot('states');

  for (const state of ['done', 'error']) {
    await t.act('setStatus', state);
    await t.waitUntil(`!document.querySelector('${busy}')`);
    const icon = tile + ' svg';
    await t.waitFor(icon);
    t.check(`${state} 显示终态图标`, await t.count(icon + (state === 'done' ? '.lucide-check' : '.lucide-x')), 1);
    t.check(`${state} 不再播放网络动画`, await t.js(`document.querySelector('${tile}').getAnimations({ subtree: true }).filter(a => a.effect.getTiming().iterations === Infinity).length`), 0);
    if (state === 'done') {
      await t.act('setStatus', 'running');
      await t.waitFor(busy);
    }
  }
}
