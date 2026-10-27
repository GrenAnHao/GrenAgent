import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PathMode } from '../features/fileExplorer/filePathDisplay';

interface FilePathModeState {
  /** 文件浏览器路径栏写相对项目根还是绝对路径。所有文件标签共用一个偏好，切一次处处一致。 */
  mode: PathMode;
  setMode: (mode: PathMode) => void;
}

export const useFilePathModeStore = create<FilePathModeState>()(
  persist(
    (set) => ({
      mode: 'relative',
      setMode: (mode) => set({ mode }),
    }),
    { name: 'pi-file-path-mode' },
  ),
);
