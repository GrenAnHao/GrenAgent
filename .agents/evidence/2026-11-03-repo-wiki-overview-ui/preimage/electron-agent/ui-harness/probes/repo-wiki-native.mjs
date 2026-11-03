export default async function (t) {
  t.ok('显示原版生成面板', await t.waitFor('[aria-label="原版 Wiki 生成"]'));
  t.ok('部分覆盖独立显示', (await t.text('[aria-label="原版生成状态"]')).includes('已发布 9 篇 · 失败 2 篇 · 部分覆盖'));
  t.ok('投影待处理可见', (await t.text('[aria-label="原版生成状态"]')).includes('pending'));
  await t.click('[data-native-intent="full"]');
  t.ok('确认包含模型和目标提交', (await t.text('[aria-label="确认外发模型"]')).includes('fixture/model'));
  t.check('未确认前无 start', (await t.act('calls')).filter(x => x.command === 'start').length, 0);
  await t.click('[aria-label="确认外发并开始"]');
  t.check('仅显式确认启动一次', (await t.act('calls')).filter(x => x.command === 'start').length, 1);
  await t.click('[aria-label="暂停原版运行"]');
  t.check('暂停绑定操作和修订', (await t.act('calls')).find(x => x.command === 'control').expected_revision, 1);
  await t.click('[aria-label="原版作者配置"] summary');
  await t.click('[aria-label="显式转换旧计划"]');
  t.ok('转换展示丢弃依赖', (await t.text('[role="alert"]')).includes('old-a -> old-b'));
  t.ok('转换后必须保存', await t.waitFor('[aria-label="保存作者配置"]:not([disabled])'));
  await t.click('[aria-label="保存作者配置"]');
  t.check('保存携带 token 防覆盖', (await t.act('calls')).find(x => x.command === 'author.save').expected_storage_token, 'token-1');
  await t.click('[aria-label="返回文档"]');
  t.ok('持久化原版概览不借用旧任务失败状态', (await t.text('[data-testid="native-wiki-overview"]')).includes('已发布 9 篇 · 失败 2 篇 · 可阅读 11 篇'));
  await t.click('.inline-source');
  t.ok('源码引用按仓库相对路径定位', (await t.events()).includes('source:src/a.ts:1-3'));
  t.check('危险引用不生成可打开按钮', await t.count('.inline-source'), 1);
  await t.shot('native-wiki');
}
