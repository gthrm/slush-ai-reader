import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {webcrypto} from 'node:crypto';
import {Blob as NodeBlob} from 'node:buffer';
import {AudioCache,type StoredAudio} from '../lib/audio-cache';
const makeAudio=():StoredAudio=>({blob:new NodeBlob(['generated audio']) as Blob,text:'Original text',language:'en',words:[{text:'Original',from:0,to:8,start:.1,end:1}],timed:true,duration:2});
beforeEach(()=>{vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('crypto',webcrypto);});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('Persistent audio cache',()=>{
  it('keeps audio and word timestamps across cache instances',async()=>{
    const first=new AudioCache('reopen');await first.set('same text and voice',makeAudio());
    const reopened=new AudioCache('reopen');const audio=(await reopened.get('same text and voice'))!;
    expect(await audio.blob.text()).toBe('generated audio');expect(audio.timed).toBe(true);expect(audio.words[0].start).toBe(.1);
  });
  it('keeps different voices in separate entries',async()=>{
    const cache=new AudioCache('voices');await cache.set('marin',makeAudio());
    expect(await cache.get('cedar')).toBeUndefined();expect(await cache.get('marin')).toBeDefined();
  });
  it('removes cached audio only on explicit clear and ignores late old writes',async()=>{
    const cache=new AudioCache('clear');const epoch=cache.epoch;await cache.set('key',makeAudio());await cache.clear();
    await cache.set('key',makeAudio(),epoch);expect(await new AudioCache('clear').get('key')).toBeUndefined();
  });
  it('expires audio after seven days',async()=>{
    const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);
    const cache=new AudioCache('expiry');await cache.set('key',makeAudio());
    vi.spyOn(Date,'now').mockReturnValue(now+8*24*60*60*1000);expect(await cache.get('key')).toBeUndefined();
  });
  it('keeps the original expiry when a clip is rewritten',async()=>{
    const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);
    const cache=new AudioCache('rewrite');await cache.set('key',makeAudio());
    vi.spyOn(Date,'now').mockReturnValue(now+6*24*60*60*1000);await cache.set('key',{...makeAudio(),duration:3});
    vi.spyOn(Date,'now').mockReturnValue(now+8*24*60*60*1000);expect(await cache.get('key')).toBeUndefined();
  });
  it('bounds the cache to 100 clips and retains the newest',async()=>{
    const cache=new AudioCache('bounded');for(let i=0;i<101;i++)await cache.set(`clip-${i}`,makeAudio());
    expect(await cache.get('clip-0')).toBeUndefined();expect(await cache.get('clip-100')).toBeDefined();
  });
});
