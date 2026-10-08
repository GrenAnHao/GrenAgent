// 尽量第一个求值：样式规则在其它模块求值时就开始插入，见 theme/installSpeedyStyles。
import './theme/installSpeedyStyles';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { RootErrorBoundary } from './components/RootErrorBoundary';
import { forceEagerImages } from './lib/forceEagerImages';
import { startClearingDevMeasures } from './lib/devPerformanceEntries';
import './index.css';

// WebView2 会把 loading="lazy" 的图片 defer 成占位符（含 @lobehub/ui 渲染 mermaid 用的 blob SVG），
// 这里全局强制图片 eager，避免 mermaid 图卡在占位不加载。
forceEagerImages();

// 开发版 React 每次渲染都留一条 performance.measure，不清会把渲染进程撑到 OOM 白屏。
if (import.meta.env.DEV) startClearingDevMeasures();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
