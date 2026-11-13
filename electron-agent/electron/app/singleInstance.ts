/** Electron app 中与单实例锁相关的最小接口，便于单测注入桩。 */
export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
}

/**
 * 应用级单实例：两个实例会各自持有 ModelRuntime，争抢同一份 auth.json 的 OAuth 刷新
 * （轮换 refresh token 被重复使用时会被判 invalid_grant）。测试环境跳过，避免单测夹具被锁挡住。
 * 返回是否取得锁；未取得时立即退出本实例，调用方不得继续启动。
 */
export function acquireSingleInstanceLock(app: SingleInstanceApp, isTest: boolean): boolean {
  if (isTest) return true;
  if (app.requestSingleInstanceLock()) return true;
  app.quit();
  return false;
}
