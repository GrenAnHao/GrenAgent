/**
 * 开发模式判定。
 *
 * Vite 会把 `import.meta.env.DEV` 在构建期折叠成常量：生产构建为 `false`，
 * 于是所有 `if (IS_DEV)` 分支（以及只被这些分支引用的模块）会被 tree-shake 掉 ——
 * 开发者工作台不会进生产包，也不存在改个开关就能在正式版里把它叫出来的后门。
 */
export const IS_DEV: boolean = import.meta.env.DEV;
