const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
function diagnostics(file, cwd, dropIntermediateFixture = false) {
  return fs.readFileSync(path.join(dir,file),'utf8').split(/\r?\n/).filter(line=>/error TS\d+/.test(line))
    .filter(line=>!dropIntermediateFixture || !line.includes('pi-sdk-compat.integration.test.ts'))
    .map(line=>line.replace(/^(.+?)(\(\d+,\d+\): error TS)/,(_m,file,tail)=>path.posix.normalize(path.posix.join(cwd,file.replaceAll('\\','/')))+tail));
}
const results = {};
for(const [name,before,cwd] of [['node','baseline-node-types.log','electron-agent'],['cli','baseline-compat-types.log','cli']]) {
  const a=diagnostics(before,cwd,true), b=diagnostics(`final-${name}-types.log`,'.');
  const added=b.filter(l=>!a.includes(l)), removed=a.filter(l=>!b.includes(l));
  results[name]={baseline:a.length,current:b.length,added,removed};
  if(added.length || removed.length)process.exitCode=1;
}
fs.writeFileSync(path.join(dir,'final-types-comparison.json'),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results));
