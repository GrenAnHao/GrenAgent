import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { RootErrorBoundary } from './components/RootErrorBoundary';
import { forceEagerImages } from './lib/forceEagerImages';
import './index.css';

// WebView2 会把 loading="lazy" 的图片 defer 成占位符（含 @lobehub/ui 渲染 mermaid 用的 blob SVG），
// 这里全局强制图片 eager，避免 mermaid 图卡在占位不加载。
forceEagerImages();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
