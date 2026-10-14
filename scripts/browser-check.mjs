// Integration test of the built MV3 extension with mocked OpenAI responses.
// Never needs a real API key and never makes a paid API request.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const tmp = await mkdtemp(join(tmpdir(),'slush-browser-'));
const extension = join(tmp,'extension');
await cp(resolve('.output/chrome-mv3'), extension, {recursive:true});
const manifest = JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*'], 'Automatic injection needs declared web access');
// Site permissions are exactly those of the production manifest.
manifest.content_security_policy.extension_pages=manifest.content_security_policy.extension_pages.replace('connect-src https://api.openai.com;', 'connect-src https://api.openai.com http://127.0.0.1:*;');
await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
const paragraph = 'Хорошее чтение помогает замечать детали. Мы сохраняем весь важный текст и читаем его последовательно. Голос делает осмысленные паузы между предложениями. ';
const html = `<!doctype html><html lang="ru"><head><meta charset="UTF-8"><title>Искусство слушать</title><style>body{font:18px/1.8 Georgia;background:#f7f5ef;color:#29382d;margin:70px auto;max-width:720px;padding:0 24px}h1{font-size:48px;line-height:1.1}h2{margin-top:42px}.tag{font:12px sans-serif;color:#8b927a;letter-spacing:3px}</style></head><body><nav class="tag">ЖУРНАЛ · КУЛЬТУРА</nav><article><h1>Искусство слушать</h1><p>Почему иногда текст лучше слышать, чем читать.</p><h2>Внимание к деталям</h2><p>${paragraph.repeat(10)}</p><p>${paragraph.repeat(6)}</p><h2>Найти свой ритм</h2><p>${paragraph.repeat(10)}</p></article></body></html>`;
const server = createServer(async (req,res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','*');
  if(req.method==='OPTIONS'){res.end();return;}
  if(!req.url.startsWith('/v1/')){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
  res.setHeader('Content-Type','application/json');
  if(unauthorized){res.statusCode=401;res.end(JSON.stringify({error:{message:'Invalid test key',type:'invalid_request_error'}}));return;}
  const body=[];for await(const data of req) body.push(data);
  const raw=Buffer.concat(body);
  if(req.url==='/v1/audio/transcriptions'){
    transcriptionRequests++;
    const marker=raw.indexOf(Buffer.from('slsh'));assert.ok(marker>=0,'Audio timing did not receive the generated audio');
    const size=raw.readUInt32LE(marker+4);const source=JSON.parse(raw.subarray(marker+8,marker+8+size).toString());
    const tokens=Array.from(new Intl.Segmenter('ru',{granularity:'word'}).segment(source.text)).filter(part=>part.isWordLike);
    const total=tokens.reduce((sum,token)=>sum+Math.max(2,token.segment.length),0);let time=.15;
    const words=tokens.map(token=>{const span=Math.max(2,token.segment.length)/total*(source.duration-.3);const result={word:token.segment,start:time,end:time+span*.85};time+=span;return result;});
    await new Promise(r=>setTimeout(r,120));res.end(JSON.stringify({task:'transcribe',language:'russian',duration:source.duration,text:source.text,words}));return;
  }
  const payload=JSON.parse(raw.toString());
  if(req.url==='/v1/responses') {
    analysisRequests++;lastPage=JSON.parse(payload.input);
    if (holdAnalysis) await analysisGate;
    const prose=lastPage.blocks.find(block=>block.kind==='paragraph');
    const plan={title:lastPage.title,pageType:'article',language:'ru',opening:'Invented speaker says. Another speaker says.',excludedBlockIds:[],spokenBlocks:prose?[{id:prose.id,text:'Invented speaker says: rewritten commentary.'}]:[]};
    res.end(JSON.stringify({id:'resp_test',object:'response',created_at:1,status:'completed',error:null,incomplete_details:null,output:[{id:'msg_test',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(plan),annotations:[]}]}]}));
  } else if(req.url==='/v1/audio/speech') {
    assert.ok(!payload.input.includes('Invented speaker'),'Generated commentary reached TTS');
    speechRequests++;speechVoices.push(payload.voice);speechInstructions.push(payload.instructions);
    const duration=payload.voice==='cedar'?10:8;
    await new Promise(r=>setTimeout(r,200));res.setHeader('Content-Type','audio/wav');res.end(wav(duration,payload.input));
  } else {res.statusCode=404;res.end('{}');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const address = `http://127.0.0.1:${server.address().port}`;
// Chromium offscreen targets bypass Playwright context.route. Point only the
// temporary test copy at the local mock server; the shipped bundle stays intact.
const apiFile=(await readdir(join(extension,'chunks'))).find(name=>name.startsWith('api-')&&name.endsWith('.js'));
const apiPath=join(extension,'chunks',apiFile);
const apiCode=await readFile(apiPath,'utf8');
assert.ok(apiCode.includes('dangerouslyAllowBrowser:!0'));
await writeFile(apiPath,apiCode.replace('dangerouslyAllowBrowser:!0',`baseURL:${JSON.stringify(address+'/v1')},dangerouslyAllowBrowser:!0`));
// Only the test copy opens its shadow root for layout inspection and clicks.
const readerPath=join(extension,'content-scripts/reader.js');
const readerCode=await readFile(readerPath,'utf8');
assert.ok(readerCode.includes('mode:"closed"'));
await writeFile(readerPath,readerCode.replace('mode:"closed"','mode:"open"'));
let context;
let debugPopup;
let speechRequests=0;
let transcriptionRequests=0;
const speechVoices=[];
const speechInstructions=[];
let analysisRequests=0;
let unauthorized=false;
let holdAnalysis=true;
let releaseAnalysis;
const analysisGate=new Promise(resolve=>{releaseAnalysis=resolve;});
let lastPage;
const errors=[];
function wav(seconds=8,text='') {
  const count=24000*seconds, buffer=Buffer.alloc(44+count*2);
  buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(24000,24);buffer.writeUInt32LE(48000,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(count*2,40);
  const data=Buffer.from(JSON.stringify({text,duration:seconds}));const chunk=Buffer.alloc(8+data.length+(data.length%2));chunk.write('slsh');chunk.writeUInt32LE(data.length,4);data.copy(chunk,8);
  const result=Buffer.concat([buffer,chunk]);result.writeUInt32LE(result.length-8,4);return result;
}
async function waitFor(check, message, timeout=15000) {
  const start=Date.now();
  while(Date.now()-start<timeout) { if(await check()) return; await new Promise(r=>setTimeout(r,100)); }
  throw new Error(message);
}
try {
  context = await chromium.launchPersistentContext(join(tmp,'profile'), {
    headless:true, channel:'chromium', args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`], viewport:{width:1280,height:900},
  });
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  await context.route('https://api.openai.com/**', route=>route.abort());
  let worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id=new URL(worker.url()).host;
  // Headless Chromium has no toolbar popup; record the native API call, then
  // exercise the same settings document below in a normal extension test tab.
  await worker.evaluate(()=>{globalThis.__slushPopupRequests=0;chrome.action.openPopup=async options=>{globalThis.__slushPopupRequests++;globalThis.__slushPopupOptions=options;};});
  const page=await context.newPage();await page.goto(address);
  await page.locator('#slush-reader-host').waitFor();
  assert.equal(analysisRequests,0);assert.equal(speechRequests,0);
  const readyBox=await page.locator('.player').boundingBox();
  assert.ok(readyBox.width<240&&readyBox.height<=50,'Default launcher is too large');
  await page.screenshot({path:'artifacts/player-ready.png'});
  await page.locator('.player').screenshot({path:'artifacts/launcher.png'});
  const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url?.startsWith(url)).id,address);
  // A popup URL opened in a test tab has itself as activeTab; emulate a toolbar popup.
  await context.addInitScript(({tabId})=>{
    if(location.protocol==='chrome-extension:' && location.pathname==='/popup.html'){
      const query=chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query=async options=>options.active&&options.currentWindow?[await chrome.tabs.get(tabId)]:query(options);
    }
  },{tabId});
  // Capture the closed shadow root inside the extension's isolated world.
  // This instrumentation exists only in the temporary browser test profile.
  await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>{
    globalThis.__slushTestShadow=document.querySelector('#slush-reader-host').shadowRoot;
    const attachShadow=Element.prototype.attachShadow;
    Element.prototype.attachShadow=function(options){const root=attachShadow.call(this,options);globalThis.__slushTestShadow=root;return root;};
    chrome.runtime.onMessage.addListener(message=>{if(message.type==='EXTRACT_PAGE')globalThis.__slushVisibleBeforeExtraction=Boolean(document.querySelector('#slush-reader-host'));});
  }}),tabId);
  // Minimize directly from the bar. It must not start reading.
  await page.locator('#mini-minimize').click();
  const [minimized]=await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>({minimized:globalThis.__slushTestShadow.querySelector('.player').classList.contains('minimized'),miniVisible:!globalThis.__slushTestShadow.getElementById('mini-player').hidden})}),tabId);
  assert.equal(minimized.result.minimized,true);assert.equal(minimized.result.miniVisible,true);
  assert.equal(analysisRequests,0);assert.equal(speechRequests,0);
  await page.screenshot({path:'artifacts/player-minimized.png'});
  await page.locator('#restore').click();
  assert.ok((await page.locator('.player').boundingBox()).width<240,'Restoring the idle launcher opened a huge player');
  await page.locator('#mini-settings').click();
  await waitFor(async()=>await worker.evaluate(()=>globalThis.__slushPopupRequests)===1,'Settings button did not open the popup');
  await page.locator('#mini-toggle').click();
  await waitFor(async()=>await worker.evaluate(()=>globalThis.__slushPopupRequests)===2,'Missing API key did not open settings automatically');
  assert.equal(analysisRequests,0);assert.equal(speechRequests,0);
  let popup=await context.newPage();debugPopup=popup;await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(()=>document.body.dataset.ready==='true');
  assert.equal(await popup.locator('.hero').count(),0,'Popup still contains the promotional block');
  assert.equal(await popup.locator('#start').count(),0,'Popup still contains a start button');
  await popup.locator('#key-help').waitFor();
  assert.equal(await popup.evaluate(()=>document.activeElement.id),'api-key','API key field was not focused');
  await popup.locator('#app').screenshot({path:'artifacts/key-setup.png'});
  const request=(type,extra={})=>popup.evaluate(args=>chrome.runtime.sendMessage({target:'background',...args}),{type,...extra});
  const state=async()=>(await request('GET_STATE',{tabId})).state;
  await popup.locator('#api-key').fill('sk-test-not-a-real-key');
  await popup.locator('#save').click();
  await waitFor(()=>analysisRequests===1,'Saving a requested API key did not resume the requested reading');
  if(!popup.isClosed())await popup.close();
  popup=await context.newPage();debugPopup=popup;await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(()=>document.body.dataset.ready==='true');
  const inspectPlayer=async()=>{
    const [result]=await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>{
      const root=globalThis.__slushTestShadow;
      const controls=['toggle','back','forward','expand','minimize','close'].map(id=>{
        const button=root.getElementById(id),svg=button.querySelector('svg');
        const b=button.getBoundingClientRect(),s=svg.getBoundingClientRect();
        const label=button.querySelector('span')?.getBoundingClientRect();
        return {id,width:s.width,height:s.height,centerOffset:Math.abs(b.x+b.width/2-s.x-s.width/2),overlappingLabel:Boolean(label&&label.y<s.bottom)};
      });
      return {visibleBeforeExtraction:globalThis.__slushVisibleBeforeExtraction,controls};
    }}),tabId);
    return result.result;
  };
  assert.equal((await state()).status,'analyzing');
  assert.equal(await page.locator('#slush-reader-host').count(),1,'Player did not appear while analysis was pending');
  const loadingLayout=await inspectPlayer();
  assert.equal(loadingLayout.visibleBeforeExtraction,true,'Player was shown after extraction');
  for(const control of loadingLayout.controls){assert.ok(control.width>0&&control.height>0);assert.ok(control.centerOffset<1,`${control.id} icon is not centered`);assert.equal(control.overlappingLabel,false,`${control.id} label overlaps its icon`);}
  await page.screenshot({path:'artifacts/player-loading.png'});
  holdAnalysis=false;releaseAnalysis();
  await waitFor(async()=>(await state()).status==='playing','Narration did not begin');
  await waitFor(async()=>(await state()).wordSync==='timed','Word timing did not synchronize');
  await request('CONTROL',{control:{action:'toggle'}});
  await waitFor(async()=>(await state()).status==='paused','Pause for word inspection failed');
  const firstWord=(await state()).words[0];
  await request('CONTROL',{control:{action:'seek',position:(firstWord.start+firstWord.end)/2}});
  await page.locator('.current-word').waitFor();
  assert.equal(await page.locator('.current-word').textContent(),firstWord.text,'Wrong original word was highlighted');
  assert.equal(await page.locator('#transcript').textContent(),(await state()).transcript,'Transcript did not preserve source text');
  await page.locator('.player').screenshot({path:'artifacts/word-highlight.png'});
  const priorAnalysis=analysisRequests,priorSpeech=speechRequests;
  await popup.locator('#voice').selectOption('cedar');
  await waitFor(async()=>(await state()).voice==='cedar','Voice selection was not auto-saved');
  assert.equal((await state()).status,'paused');assert.equal(speechRequests,priorSpeech,'Paused voice change generated unnecessary audio');
  await request('CONTROL',{control:{action:'toggle'}});
  await waitFor(async()=>{const s=await state();return s.status==='playing'&&s.voice==='cedar'&&s.wordSync==='timed';},'New voice did not resume with word timing');
  assert.ok(speechVoices.includes('cedar'),'New voice was not sent to TTS');assert.equal(analysisRequests,priorAnalysis,'Voice change reanalysed the page');
  assert.equal(await page.locator('#voice-label').textContent(),'Cedar');
  await popup.getByText('Calm',{exact:true}).click();
  await waitFor(()=>speechInstructions.some(value=>value.includes('calm, soft, relaxed')),'Reading style did not update live');
  await waitFor(async()=>(await state()).status==='playing','Reading did not resume after style change');
  assert.equal(lastPage.extraction,'readability');
  assert.equal(await page.locator('#slush-reader-host').count(),1);
  const [boundary]=await popup.evaluate(async tabId=>chrome.scripting.executeScript({target:{tabId},func:async()=>{
    const settings=await chrome.runtime.sendMessage({target:'background',type:'GET_SETTINGS'});
    let storageAccessible=false;
    try { const stored=await chrome.storage.local.get('settings');storageAccessible=Boolean(stored.settings); } catch {}
    return {allowed:settings.ok,storageAccessible};
  }}),tabId);
  assert.equal(boundary.result.allowed,false,'Content script received settings');
  assert.equal(boundary.result.storageAccessible,false,'Content script accessed API key storage');
  await popup.locator('main').evaluate(node=>{node.scrollTop=0;});
  await popup.locator('#app').screenshot({path:'artifacts/popup.png'});
  await popup.locator('main').evaluate(node=>{node.scrollTop=node.scrollHeight;});
  await popup.locator('#app').screenshot({path:'artifacts/popup-settings.png'});
  await page.screenshot({path:'artifacts/player.png'});
  await page.locator('.player').screenshot({path:'artifacts/full-player.png'});
  await page.setViewportSize({width:600,height:900});
  const compactLayout=await inspectPlayer();
  for(const control of compactLayout.controls)assert.ok(control.centerOffset<1,`${control.id} icon moved in compact layout`);
  await page.screenshot({path:'artifacts/player-compact.png'});
  await page.setViewportSize({width:1280,height:900});
  const contentReply=await page.evaluate(async()=>{
    // Use the content script's isolated world below for storage boundary checks.
    return document.querySelector('#slush-reader-host')?.id;
  });assert.equal(contentReply,'slush-reader-host');
  const control=control=>request('CONTROL',{control});
  await control({action:'toggle'});
  await waitFor(async()=>(await state()).status==='paused','Pause failed');
  const paused=(await state()).position;
  await new Promise(r=>setTimeout(r,600));
  assert.ok(Math.abs((await state()).position-paused)<.1,'Position advanced while paused');
  await control({action:'seek',position:10});
  await waitFor(async()=>{const s=await state();return s.index>0 && s.status==='paused';},'Seek did not reach next chunk while paused');
  await control({action:'speed',speed:1.5});assert.equal((await state()).speed,1.5);
  await control({action:'toggle'});await waitFor(async()=>(await state()).status==='playing','Resume failed');
  await popup.close();
  await new Promise(r=>setTimeout(r,700));
  popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
  assert.equal((await state()).status,'playing','Playback stopped after popup closed');
  // A second injection must reuse the single listener/player instance.
  const beforeRestart=analysisRequests;
  await request('START_TAB',{tabId});await waitFor(async()=>(await state()).status==='playing','Second start failed');
  assert.equal(analysisRequests,beforeRestart,'Prepared text was regenerated on repeat reading');assert.equal((await state()).textCached,true);
  assert.equal(await page.locator('#slush-reader-host').count(),1);
  await control({action:'stop'});await waitFor(async()=>await page.locator('#slush-reader-host').count()===0,'Player remained after stop');
  assert.equal((await state()).status,'idle');
  // Close the offscreen document as well: replay must use persistent audio,
  // rather than an object URL or an in-memory engine cache.
  const savedSpeech=speechRequests,savedAnalysis=analysisRequests;
  await worker.evaluate(()=>chrome.offscreen.closeDocument());
  await request('START_TAB',{tabId});await waitFor(async()=>(await state()).status==='playing','Replay after audio document close failed');
  assert.equal(speechRequests,savedSpeech,'Closing the player discarded generated audio');
  assert.equal(analysisRequests,savedAnalysis,'Closing audio discarded the prepared text');
  await control({action:'stop'});
  // Hold extraction so Stop can be exercised while the immediate bar is preparing.
  await worker.evaluate(()=>{
    const original=chrome.tabs.sendMessage;
    globalThis.__slushReleaseExtraction=undefined;
    const gate=new Promise(resolve=>{globalThis.__slushReleaseExtraction=resolve;});
    globalThis.__slushRestoreSend=()=>{chrome.tabs.sendMessage=original;};
    chrome.tabs.sendMessage=async(...args)=>{if(args[1]?.type==='EXTRACT_PAGE')await gate;return original.apply(chrome.tabs,args);};
  });
  const beforeCancel=analysisRequests;
  const cancelledStart=request('START_TAB',{tabId});
  await waitFor(async()=>(await state()).status==='preparing','Immediate preparation state was not shown');
  assert.equal(await page.locator('#slush-reader-host').count(),1);
  await control({action:'stop'});
  await waitFor(async()=>await page.locator('#slush-reader-host').count()===0,'Stop did not dismiss the preparing player');
  await worker.evaluate(()=>{globalThis.__slushReleaseExtraction();globalThis.__slushRestoreSend();});
  assert.equal((await cancelledStart).ok,true);
  assert.equal((await state()).status,'idle');
  assert.equal(analysisRequests,beforeCancel,'Cancelled preparation started a paid analysis request');
  await page.evaluate(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('article>p'));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);});
  await request('START_TAB',{tabId});await waitFor(async()=>(await state()).status==='playing','Selection reading failed');
  assert.equal(lastPage.extraction,'selection');assert.equal(lastPage.blocks.length,1);
  assert.equal((await state()).transcript,'Почему иногда текст лучше слышать, чем читать.');
  await control({action:'stop'});
  unauthorized=true;
  await request('CLEAR_AUDIO');
  await request('START_TAB',{tabId});await waitFor(async()=>(await state()).status==='error','API failure was not shown');
  assert.match((await state()).error,/API key was rejected/);
  unauthorized=false;
  await control({action:'retry'});await waitFor(async()=>(await state()).status==='playing','Retry after failure did not recover');
  await control({action:'toggle'});await waitFor(async()=>(await state()).status==='paused','Final pause failed');
  // BLOBS reason retains offscreen document across a >30 second pause.
  await new Promise(r=>setTimeout(r,31_000));
  assert.equal((await state()).status,'paused','Pause lost state after 30 seconds');
  await control({action:'toggle'});await waitFor(async()=>(await state()).status==='playing','Resume after long pause failed');
  await page.close();await waitFor(async()=>(await state()).status==='idle','Closing source tab did not stop playback');
  assert.deepEqual(errors,[],'Browser page errors');
  console.log(JSON.stringify({ok:true,analysisRequests,speechRequests,transcriptionRequests,checks:['automatic launcher without opening popup','launcher under 240×50','no automatic API requests','minimize and restore','settings button','missing key opens settings','key field focus','save key resumes requested reading','no promotional popup','player before extraction','player before model response','word synchronization','original word highlight','voice auto-save','paused voice update without extra synthesis','live voice and style changes','prepared text cache','audio survives player and offscreen close','replay without new TTS','icon alignment','compact layout','cancel preparation','semantic plan','key isolation','playback','pause','cross-chunk seek','speed','popup lifecycle','single injection','selection','API errors','retry','31-second pause','tab-close cleanup'],screenshots:['artifacts/word-highlight.png','artifacts/launcher.png','artifacts/full-player.png','artifacts/key-setup.png','artifacts/popup.png','artifacts/player-compact.png']},null,2));
} catch(error) {
  if(debugPopup && !debugPopup.isClosed()) {
    console.error('Popup notice:',await debugPopup.locator('#notice').textContent());
    console.error('Player state:',await debugPopup.evaluate(()=>chrome.runtime.sendMessage({target:'background',type:'GET_STATE'})).catch(e=>e.message));
    await debugPopup.screenshot({path:'artifacts/browser-failure.png'});
  }
  console.error('API requests:',{analysisRequests,speechRequests});
  console.error('Page errors:',errors);
  throw error;
} finally {
  await context?.close();await new Promise(r=>server.close(r));await rm(tmp,{recursive:true,force:true});
}
