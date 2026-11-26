import { app } from 'electron';

const MIB = 1024 * 1024;

export default async function (t) {
  const read = () => t.act('metrics');
  const rss = () => (app.getAppMetrics().find(p => p.pid === t.win.webContents.getOSProcessId())?.memory.workingSetSize ?? 0) / 1024;
  const opt = '[data-testid="inline-question-opt-q-yes"]';
  const button = '[data-testid="inline-question-continue"]';
  const card = '[data-testid="inline-question"]';

  for (const parallel of [false, true]) {
    await t.act('seed', parallel ? 1 : 0);
    const before = await read();
    const label = parallel ? '双项目' : '单项目';
    const rounds = parallel ? 2 : 1;
    const baselines = Object.values(before.amounts);
    t.ok(`${label}每份历史约 71 MiB`, baselines.length === rounds && baselines.every(x => x.initial > 70 * MIB && x.initial < 72 * MIB));
    let peak = rss();
    const sample = setInterval(() => { peak = Math.max(peak, rss()); }, 20);
    try {
      await t.act('begin', parallel);
      t.ok(`${label}询问卡已显示`, await t.waitFor(opt));
      if (!parallel) await t.shot('question-under-streaming-load');
      await t.click(opt, 20);
      await t.click(button, 20);
      t.ok(`${label}答复后收卡`, await t.waitUntil(`!document.querySelector('${card}')`, 1000));
      await t.sleep(750);
      const result = await read();
      t.check(`${label}仅发送一次答复且未等前端删除草稿`, [result.replies, result.draftDeletes], [rounds, 0]);
      t.ok(`${label}确认延迟记录在 250ms 内`, result.closedAfterMs > 0 && result.closedAfterMs < 250);
      const data = Object.values(result.amounts);
      t.ok(`${label}历史持续增长，批次没有覆盖旧全文`, data.every((x, i) => x.full === 0 && x.batches > baselines[i].batches && result.rows[i] > before.rows[i]));
      t.ok(`${label}新增历史只发 KiB 级尾段，补 ID 不重复读取`, data.every(x => x.patch > 0 && x.patch < 32 * 1024 && x.metadata === 1));
      const added = data.reduce((total, x, i) => total + x.patch - baselines[i].patch, 0);
      t.info(`${label}: click-to-close=${result.closedAfterMs.toFixed(1)} ms; renderer peak=${peak.toFixed(1)} MiB; history patch=${added} B`);
    } finally {
      clearInterval(sample);
      await t.act('stop');
    }
  }
}
