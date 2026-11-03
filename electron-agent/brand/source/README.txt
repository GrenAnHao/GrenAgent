GrenAgent SVG 资产
==================

文件
----
grenagent-logo.svg        完整横版 Logo；透明背景；默认黑色；currentColor。
grenagent-icon.svg        独立 G 图标；透明背景；正方形画布；currentColor。
grenagent-logo-white.svg  完整横版 Logo 的固定白色版本，适合深色背景。
grenagent-icon-white.svg  独立图标的固定白色版本，适合深色背景。
grenagent-preview.png    预览图，不用于替代 SVG 原文件。

实现
----
基于已确认的 GrenAgent 概念图重绘。G 图标采用经过几何整理的单一路径；
字标沿原图轮廓转为贝塞尔路径，保留字形、字间距及图文比例。
背景透明。没有嵌入 PNG、外部字体、脚本或外部资源。
SVG 可以在浏览器、Figma、Illustrator 和 Inkscape 中继续编辑。

画布
----
完整 Logo: viewBox="0 0 1514 378"，四周留白 32 单位。
独立图标: viewBox="0 0 352 352"，图形为 320 × 314 单位，居中排列。
这份图标保留原造型；建议常规 UI 使用 24 px 及以上。

网页引用
--------
<img src="/assets/grenagent-logo.svg" alt="GrenAgent" style="width:220px;height:auto" />
<img src="/assets/grenagent-icon.svg" alt="GrenAgent" width="32" height="32" />

颜色
----
把 SVG 源码直接内联到 HTML 时，currentColor 会继承所在元素的 CSS color。
例如给外层容器设置 color: #22c55e;，图形和文字会一起变色。
使用 <img src="...svg"> 引用时，SVG 不会继承页面的 color。
这种情况下可使用固定白色版本，或直接修改 SVG 根元素的 fill。

React
-----
可把 SVG 作为图片导入，或将 SVG 源码改为 React 组件。
内联 JSX 时，把 fill-rule 改为 fillRule；保留 viewBox 并按需设置 width/height。
