// 副作用模块，main.tsx 第一个导入它。@lobehub/ui 的 createStaticStyles 在模块求值时就插样式，
// 等 main.tsx 的函数体再打开 speedy，已经多出一千多个 <style> 标签。
// 生产包里入口 chunk 静态导入的共享 chunk（Icon、ActionIcon 等）仍先于这里求值，约 80 条规则各占一个标签；
// 要全部覆盖得开 rolldown 的 strictExecutionOrder，代价不值。
import { enableSpeedyStyles } from './speedyStyles';

enableSpeedyStyles();
