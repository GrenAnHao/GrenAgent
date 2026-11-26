import base from '../../../electron-agent/vitest.config.ts';
import { currentTypeScript } from './source-vitest.config.mjs';
export default {
  ...base,
  plugins: [currentTypeScript, ...(base.plugins ?? [])],
  test: { ...base.test, projects: base.test.projects.map(project => ({ ...project, plugins: [currentTypeScript] })) },
};
