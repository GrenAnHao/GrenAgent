const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const yaml = require(path.join(root, 'electron-agent/node_modules/yaml'));
const expected = ['pi-ai','pi-agent-core','pi-coding-agent','pi-codemode','pi-mcp','pi-tui','pi-telemetry','pi-schema'].map(n=>'@earendil-works/'+n);
function resolvePackage(from, name) {
  for (let dir=fs.realpathSync(from);;dir=path.dirname(dir)) {
    const p=path.join(dir,'node_modules',name,'package.json');
    if(fs.existsSync(p)) return fs.realpathSync(p);
    if(dir===path.dirname(dir)) throw new Error(`Cannot resolve ${name} from ${from}`);
  }
}
const result = {};
for (const project of ['cli','extensions','electron-agent']) {
  const dir=path.join(root,project), manifest=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
  const queue=Object.entries({...manifest.dependencies,...manifest.devDependencies}).filter(([n])=>expected.includes(n)).map(([n])=>resolvePackage(dir,n));
  const seen=new Set(), packages=[];
  while(queue.length) {
    const file=queue.shift(); if(seen.has(file))continue; seen.add(file);
    const pkg=JSON.parse(fs.readFileSync(file,'utf8'));
    packages.push({name:pkg.name,version:pkg.version,path:path.relative(root,file)});
    for(const name of Object.keys(pkg.dependencies||{})) if(expected.includes(name)) queue.push(resolvePackage(path.dirname(file),name));
  }
  for (const name of expected) if(!packages.some(p=>p.name===name&&p.version==='1.5.1')) throw Error(`${project}: missing target ${name}`);
  if(packages.some(p=>p.version!=='1.5.1'))throw Error(`${project}: mixed SDK version`);
  const npm=JSON.parse(fs.readFileSync(path.join(dir,'package-lock.json'),'utf8'));
  const npmPackages=Object.entries(npm.packages).filter(([p])=>expected.some(n=>p.endsWith('node_modules/'+n))).map(([p,v])=>({name:p.split('node_modules/').pop(),version:v.version}));
  if(npmPackages.some(p=>p.version!=='1.5.1')||!expected.every(n=>npmPackages.some(p=>p.name===n)))throw Error(`${project}: npm lock mismatch`);
  const pnpm=yaml.parse(fs.readFileSync(path.join(dir,'pnpm-lock.yaml'),'utf8'));
  const pnpmPackages=Object.keys(pnpm.packages).filter(k=>expected.some(n=>k.startsWith(n+'@')));
  if(pnpmPackages.some(p=>!p.endsWith('@1.5.1'))||pnpmPackages.length!==expected.length)throw Error(`${project}: pnpm lock mismatch`);
  result[project]={packages,npmPackages,pnpmPackages};
}
fs.writeFileSync(path.join(__dirname,'dependency-graphs-1.5.1.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(result).map(([p,r])=>[p,{actual:r.packages.map(v=>v.name+'@'+v.version),npm:r.npmPackages.length,pnpm:r.pnpmPackages.length}]))));
