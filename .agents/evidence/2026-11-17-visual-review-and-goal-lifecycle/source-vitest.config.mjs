import { existsSync } from 'node:fs';
import path from 'node:path';

// Local verification only. Do not remove the user's ignored build artifacts.
export const currentTypeScript = {
  name: 'verify-current-typescript',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || importer.includes('/node_modules/') || importer.includes('\\node_modules\\')) return;
    if (!source.startsWith('.') || !source.endsWith('.js')) return;
    const base = path.resolve(path.dirname(importer.split('?')[0]), source.slice(0, -3));
    for (const suffix of ['.ts', '.tsx']) {
      if (existsSync(base + suffix)) return base + suffix;
    }
  },
};
export default { plugins: [currentTypeScript] };
