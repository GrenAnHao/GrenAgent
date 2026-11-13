import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';
const root=pathResolve(fileURLToPath(new URL('../..',import.meta.url))).toLowerCase();
export async function resolve(specifier,context,next){
 if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:')){
  const parent=fileURLToPath(context.parentURL);
  if(parent.toLowerCase().startsWith(root)&&!parent.includes('node_modules')){
   const file=fileURLToPath(new URL(specifier,context.parentURL));
   const candidates=specifier.endsWith('.js')?[file.slice(0,-3)+'.ts',file.slice(0,-3)+'.tsx']:/\.[a-z]+$/i.test(file)?[]:[file+'.ts',file+'.tsx'];
   for(const candidate of candidates)if(existsSync(candidate))return next(pathToFileURL(candidate).href,context);
  }
 }
 return next(specifier,context);
}
