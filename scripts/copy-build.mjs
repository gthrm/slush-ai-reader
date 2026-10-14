import { cp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

// Generated, user-visible installation folder; source remains in entrypoints/.
const destination = resolve('extension');
await rm(destination, {recursive:true,force:true});
await cp(resolve('.output/chrome-mv3'), destination, {recursive:true});
if(process.argv.includes('--zip')) {
  const {name,version}=JSON.parse(await readFile('package.json','utf8'));
  const file=`${name}-${version}-chrome.zip`;
  await cp(resolve('.output',file),resolve('slush-chrome-mv3.zip'));
}
console.log('Ready to install: extension/');
