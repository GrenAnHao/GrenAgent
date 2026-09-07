const { cp, stat } = require('node:fs/promises');
const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');
const { Arch } = require('electron-builder');

// electron-builder deliberately filters nested node_modules. CodeGraph ships
// its SDK dependencies inside the platform bundle, not in its dependency map.
module.exports = async function packageCodeGraph(context) {
  const sdkRequire = createRequire(require.resolve('@colbymchenry/codegraph'));
  const platform = `codegraph-${context.electronPlatformName}-${Arch[context.arch]}`;
  const source = join(dirname(sdkRequire.resolve(`@colbymchenry/${platform}/package.json`)), 'lib/node_modules');
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const target = join(resources, 'app.asar.unpacked/node_modules/@colbymchenry', platform, 'lib');
  if (!(await stat(target)).isDirectory()) throw new Error('CodeGraph platform SDK must be unpacked before copying its dependencies');
  await cp(source, join(target, 'node_modules'), { recursive: true, dereference: true });
};
