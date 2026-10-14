import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults, type PageContent } from '../lib/types';
import { webcrypto } from 'node:crypto';

const api = vi.hoisted(() => ({ analyze: vi.fn(), synthesize: vi.fn(), transcribeWords: vi.fn(), clientFor: vi.fn(() => ({})) }));
vi.mock('../lib/api', () => api);
import { ReadingEngine } from '../lib/engine';

class FakeAudio extends EventTarget {
  src = ''; currentTime = 0; duration = 10; playbackRate = 1; paused = true;
  play = vi.fn(async () => { this.paused = false; });
  pause() { this.paused = true; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() { if (this.src) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); }
}
const page: PageContent = { url:'https://example.com',title:'Текст',author:'',site:'example.com',language:'ru',extraction:'readability',blocks:[
  {id:0,kind:'paragraph',text:'Первый текст. '.repeat(100)},
  {id:1,kind:'heading',text:'Второй раздел'},
  {id:2,kind:'paragraph',text:'Следующий текст. '.repeat(100)},
] };
let audio: FakeAudio;
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve}; }
async function until(check:()=>boolean) { for(let i=0;i<30;i++){if(check())return;await new Promise(r=>setTimeout(r,0));}throw new Error('Condition not reached'); }
beforeEach(()=>{
  vi.clearAllMocks();
  vi.stubGlobal('crypto',webcrypto);
  vi.stubGlobal('Audio',class extends FakeAudio { constructor(){super();audio=this;} });
  let count=0;
  vi.stubGlobal('URL', class extends URL { static createObjectURL=vi.fn(()=>`blob:test-${++count}`); static revokeObjectURL=vi.fn(); });
  api.analyze.mockImplementation(async()=>({title:'Текст',pageType:'article',language:'ru',opening:'',excludedBlockIds:[],spokenBlocks:[]}));
  api.synthesize.mockImplementation(async()=>new Blob(['fake']));
  api.transcribeWords.mockImplementation(async()=>[]);
});
afterEach(()=>vi.unstubAllGlobals());
describe('Reading engine lifecycle',()=>{
  it('pauses and resumes without creating another speech request for the current chunk',async()=>{
    const engine=new ReadingEngine(()=>{});await engine.start(page,defaults,4);
    expect(engine.snapshot().status).toBe('playing');
    audio.currentTime=3;const requests=api.synthesize.mock.calls.length;
    await engine.control({action:'toggle'});expect(engine.snapshot().status).toBe('paused');
    await engine.control({action:'toggle'});expect(engine.snapshot().position).toBe(3);
    expect(api.synthesize.mock.calls.length).toBe(requests);engine.stop();
  });
  it('honours pause while the first TTS request is still pending',async()=>{
    const tts=deferred<Blob>();api.synthesize.mockReturnValueOnce(tts.promise);
    const engine=new ReadingEngine(()=>{});const started=engine.start(page,defaults,4);
    await until(()=>engine.snapshot().status==='buffering');
    await engine.control({action:'toggle'});tts.resolve(new Blob(['fake']));await started;
    expect(engine.snapshot().status).toBe('paused');expect(audio.play).not.toHaveBeenCalled();engine.stop();
  });
  it('ignores a stale model response after stop without synthesizing any audio',async()=>{
    const pending=deferred<any>();api.analyze.mockReturnValueOnce(pending.promise);
    const engine=new ReadingEngine(()=>{});const started=engine.start(page,defaults,4);engine.stop();
    pending.resolve({title:'Текст',pageType:'article',language:'ru',opening:'',excludedBlockIds:[],spokenBlocks:[]});await started;
    expect(engine.snapshot().status).toBe('idle');expect(api.synthesize).not.toHaveBeenCalled();
  });
  it('does not leak a Blob URL when synthesis finishes after stop',async()=>{
    const pending=deferred<Blob>();api.synthesize.mockReturnValueOnce(pending.promise);
    const engine=new ReadingEngine(()=>{});const started=engine.start(page,defaults,4);
    await until(()=>engine.snapshot().status==='buffering');engine.stop();pending.resolve(new Blob(['fake']));await started;
    expect(URL.createObjectURL).not.toHaveBeenCalled();expect(engine.snapshot().status).toBe('idle');
  });
  it('keeps cross-chunk seek paused and uses cached audio to seek backwards',async()=>{
    const engine=new ReadingEngine(()=>{});await engine.start(page,defaults,4);await engine.control({action:'toggle'});
    await engine.control({action:'seek',position:12});
    expect(engine.snapshot().index).toBe(1);expect(engine.snapshot().status).toBe('paused');
    const requests=api.synthesize.mock.calls.length;
    await engine.control({action:'seek',position:2});
    expect(engine.snapshot().index).toBe(0);expect(engine.snapshot().position).toBe(2);expect(api.synthesize.mock.calls.length).toBe(requests);engine.stop();
  });
  it('cleans up every retained object URL on stop',async()=>{
    const engine=new ReadingEngine(()=>{});await engine.start(page,defaults,4);
    await until(()=>engine.snapshot().cached===2);engine.stop();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);expect(engine.snapshot().cached).toBe(0);
  });
  it('automatically advances to the next chunk and preserves playback speed',async()=>{
    const engine=new ReadingEngine(()=>{});await engine.start(page,defaults,4);await engine.control({action:'speed',speed:1.5});
    audio.dispatchEvent(new Event('ended'));await until(()=>engine.snapshot().index===1&&engine.snapshot().status==='playing');
    expect(audio.playbackRate).toBe(1.5);engine.stop();
  });
  it('shows a readable API error and can retry the same source page',async()=>{
    api.analyze.mockRejectedValueOnce(Object.assign(new Error('Invalid key'),{status:401}));
    const engine=new ReadingEngine(()=>{});await engine.start(page,defaults,4);
    expect(engine.snapshot().status).toBe('error');expect(engine.snapshot().error).toContain('API key was rejected');
    await engine.control({action:'retry'});expect(engine.snapshot().status).toBe('playing');engine.stop();
  });
  it('reuses prepared text after stop without calling the analysis model again',async()=>{
    const engine=new ReadingEngine(()=>{});await engine.start(page,defaults,4);engine.stop();
    await engine.start(page,defaults,4);
    expect(api.analyze).toHaveBeenCalledTimes(1);expect(engine.snapshot().textCached).toBe(true);engine.stop();
  });
  it('reuses finished audio after closing the player without another TTS request',async()=>{
    const engine=new ReadingEngine(()=>{});await engine.start(page,defaults,4);await until(()=>engine.snapshot().cached===2);
    const requests=api.synthesize.mock.calls.length;engine.stop();await engine.start(page,defaults,4);
    expect(api.synthesize.mock.calls.length).toBe(requests);engine.stop();
  });
  it('switches voice during playback without reanalysing the text or changing the chunk',async()=>{
    const settings={...defaults,apiKey:'sk-test',highlightWords:false};
    const engine=new ReadingEngine(()=>{});await engine.start(page,settings,4);audio.currentTime=3;
    await engine.applySettings({...settings,voice:'cedar'});
    expect(engine.snapshot().voice).toBe('cedar');expect(engine.snapshot().status).toBe('playing');expect(engine.snapshot().index).toBe(0);
    expect(engine.snapshot().position).toBeGreaterThan(2.5);expect(api.analyze).toHaveBeenCalledTimes(1);
    expect(api.synthesize.mock.calls.some(call=>call[2].voice==='cedar')).toBe(true);engine.stop();
  });
  it('changes voice while paused without paying for new audio until resume',async()=>{
    const settings={...defaults,apiKey:'sk-test',highlightWords:false};
    const engine=new ReadingEngine(()=>{});await engine.start(page,settings,4);await engine.control({action:'toggle'});
    const count=api.synthesize.mock.calls.length;
    await engine.applySettings({...settings,voice:'cedar'});
    expect(engine.snapshot().status).toBe('paused');expect(api.synthesize.mock.calls.length).toBe(count);
    await engine.control({action:'toggle'});expect(api.synthesize.mock.calls.some(call=>call[2].voice==='cedar')).toBe(true);engine.stop();
  });
  it('reuses completed audio when switching back to the same voice and style',async()=>{
    const settings={...defaults,apiKey:'sk-test',highlightWords:false};
    const engine=new ReadingEngine(()=>{});await engine.start(page,settings,4);await until(()=>engine.snapshot().cached===2);
    await engine.applySettings({...settings,voice:'cedar'});await until(()=>engine.snapshot().cached===4);
    const requests=api.synthesize.mock.calls.length;
    await engine.applySettings(settings);expect(api.synthesize.mock.calls.length).toBe(requests);engine.stop();
  });
  it('does not regenerate audio when only playback speed changes',async()=>{
    const settings={...defaults,apiKey:'sk-test'};
    const engine=new ReadingEngine(()=>{});await engine.start(page,settings,4);const count=api.synthesize.mock.calls.length;
    await engine.applySettings({...settings,speed:1.5});expect(audio.playbackRate).toBe(1.5);expect(api.synthesize.mock.calls.length).toBe(count);engine.stop();
  });
  it('bounds retained audio when many voice delivery variants are generated',async()=>{
    const settings={...defaults,apiKey:'sk-test',highlightWords:false};
    const engine=new ReadingEngine(()=>{});await engine.start(page,settings,4);
    for(let i=0;i<12;i++)await engine.applySettings({...settings,instructions:`Delivery variant ${i}`});
    expect(engine.snapshot().cached).toBeLessThanOrEqual(16);engine.stop();
  });
  it('uses real word intervals and clears the highlight during pauses in speech',async()=>{
    const short={...page,blocks:[{id:0,kind:'paragraph' as const,text:'Hello beautiful world.'}]};
    api.analyze.mockResolvedValueOnce({title:'Text',pageType:'article',language:'en',excludedBlockIds:[],spokenBlocks:[]});
    api.transcribeWords.mockResolvedValueOnce([{word:'Hello',start:0.2,end:1},{word:'beautiful',start:1.5,end:3},{word:'world',start:4,end:5}]);
    const engine=new ReadingEngine(()=>{});await engine.start(short,{...defaults,apiKey:'sk-test'},4);
    await until(()=>engine.snapshot().wordSync==='timed');
    audio.currentTime=0.5;expect(engine.snapshot().activeWord).toBe(0);
    audio.currentTime=1.2;expect(engine.snapshot().activeWord).toBe(-1);
    audio.currentTime=2;expect(engine.snapshot().activeWord).toBe(1);engine.stop();
  });
});
