// Uses the shipped manifest unchanged and never opens the popup or calls OpenAI.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const tmp=await mkdtemp(join(tmpdir(),'slush-startup-'));
const extension=join(tmp,'extension');
await cp(resolve('.output/chrome-mv3'),extension,{recursive:true});
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><title>Startup test</title></head><body><h1>Existing page</h1><p>A normal page that was opened before installing the extension.</p></body></html>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const address=`http://127.0.0.1:${server.address().port}`;
let context;
async function hasPanel(page,timeout=2000){try{await page.locator('#slush-reader-host').waitFor({timeout});return true;}catch{return false;}}
try{
  context=await chromium.launchPersistentContext(join(tmp,'profile'),{headless:true,channel:'chromium',ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging']});
  await context.route('https://api.openai.com/**',route=>{throw new Error('Startup must not call OpenAI');});
  const existing=await context.newPage();await existing.goto(address+'/existing');
  const cdp=await context.browser().newBrowserCDPSession();
  const loaded=await cdp.send('Extensions.loadUnpacked',{path:extension});
  const existingAfterInstall=await hasPanel(existing);
  const fresh=await context.newPage();await fresh.goto(address+'/new');
  const freshPage=await hasPanel(fresh);
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const permissions=await worker.evaluate(()=>chrome.permissions.getAll());
  let existingAfterReload;
  if(process.argv.includes('--assert')){
    assert.equal(existingAfterInstall,true,'Existing tab did not receive the panel after install');
    assert.equal(freshPage,true,'New tab did not receive the panel');
    await existing.evaluate(()=>document.getElementById('slush-reader-host')?.remove());
    await fresh.evaluate(()=>document.getElementById('slush-reader-host')?.remove());
    const manager=await context.newPage();await manager.goto('chrome://extensions');
    const devMode=manager.locator('#devMode');
    if(!await devMode.evaluate(element=>element.checked))await devMode.click();
    const item=manager.locator(`extensions-item[id="${loaded.id}"]`);
    const newWorker=context.waitForEvent('serviceworker',{timeout:10000}).catch(()=>undefined);
    await item.locator('#dev-reload-button').click();
    existingAfterReload=await hasPanel(existing,10000);
    if(!existingAfterReload){
      console.log('Extensions after reload:',JSON.stringify(await cdp.send('Extensions.getExtensions')));
      const reloaded=await newWorker;
      if(reloaded)console.log('Reloaded worker:',await reloaded.evaluate(async()=>({permissions:await chrome.permissions.getAll(),tabs:(await chrome.tabs.query({})).map(t=>({id:t.id,url:t.url,status:t.status})),session:await chrome.storage.session.get(null)})));
      else console.log('No replacement worker');
    }
    assert.equal(existingAfterReload,true,'Existing tab did not receive the panel after extension reload');
    assert.equal(await hasPanel(fresh,10000),true,'Second tab did not receive the panel after extension reload');
    assert.equal(await existing.locator('#slush-reader-host').count(),1,'Duplicate panels after reload');
  }
  console.log(JSON.stringify({extension:loaded.id,existingAfterInstall,freshPage,existingAfterReload,permissions},null,2));
  if(process.argv.includes('--assert')){
    assert.equal(existingAfterInstall,true,'Existing tab did not receive the panel after install');
    assert.equal(freshPage,true,'New tab did not receive the panel');
  }
}finally{await context?.close();await new Promise(r=>server.close(r));await rm(tmp,{recursive:true,force:true});}
