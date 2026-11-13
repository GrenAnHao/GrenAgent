import {copyFileSync,mkdirSync}from'node:fs';import{join}from'node:path';import{fileURLToPath}from'node:url';
const evidence=fileURLToPath(new URL('../../../.agents/evidence/2026-11-10-observe-desktop-model-requests/',import.meta.url));
export default async function(t){
 await t.click('summary');t.ok('当前作用域请求',await t.waitForText('[data-testid="request-observation-details"]','alias-A'));t.ok('官方排期不称发送',(await t.text('[data-testid="warming-observation"]')).includes('尚未发送'));
 await t.key('Tab');await t.key('Space');await t.act('push');await t.click('[data-testid="request-preview"]');
 t.ok('脱敏预览',await t.waitFor('[data-testid="request-structure-preview"]'));t.ok('结构隐藏正文',(await t.text('[data-testid="request-structure-preview"]')).includes('[redacted]'));
 await t.click('[data-testid="request-export"]');t.ok('写入失败保留预览',await t.waitForText('[role="alert"]','可重试'));await t.click('[data-testid="request-export"]');
 await t.act('truncate');t.ok('有界截断',await t.waitForText('[role="status"]','已截断'));await t.act('finish');t.ok('最终响应模型',await t.waitForText('[data-testid="request-observation-details"]','actual-A'));
 mkdirSync(evidence,{recursive:true});copyFileSync(await t.shot('request-observability-dark'),join(evidence,'request-observability-dark.png'));
 await t.click('summary');t.ok('关闭清除',await t.waitUntil(`!document.querySelector('[data-testid="request-observation-details"]')`));await t.click('summary');t.ok('重开默认关闭',await t.waitUntil(`document.querySelector('[role="switch"]').getAttribute('aria-checked')==='false'`));
 await t.click('[data-testid="scope-b"]');await t.click('summary');t.ok('会话B隔离',await t.waitForText('[data-testid="request-observation-details"]','alias-B'));t.ok('B不沿用A模型',!(await t.text('[data-testid="request-observation-details"]')).includes('actual-A'));
 await t.setTheme('light');await t.resize(460,780);await t.sleep(350);t.ok('窄屏不横溢',await t.js('document.documentElement.scrollWidth<=innerWidth'));copyFileSync(await t.shot('request-observability-light-narrow'),join(evidence,'request-observability-light-narrow.png'));await t.wheel('[data-testid="request-observation-details"]',700);await t.sleep(200);t.ok('窄屏可滚到操作',await t.hitTest('[role="switch"]'));copyFileSync(await t.shot('request-observability-light-controls'),join(evidence,'request-observability-light-controls.png'));
}
