import { clear, createStore, delMany, get, setMany, type UseStore } from 'idb-keyval';
import type { TranscriptWord } from './types';

export interface StoredAudio {
  blob: Blob; text: string; language: string; words: TranscriptWord[];
  timed: boolean; duration: number;
}
interface CacheIndexItem { bytes: number; savedAt: number; touchedAt: number }
type CacheIndex = Record<string, CacheIndexItem>;
const lifetime = 7 * 24 * 60 * 60 * 1000;
const maxBytes = 64 * 1024 * 1024;
const maxEntries = 100;

export class AudioCache {
  private store?: UseStore;
  private memory = new Map<string, StoredAudio>();
  private writes: Promise<void> = Promise.resolve();
  private hashes = new Map<string, Promise<string>>();
  epoch = 0;

  constructor(private database = 'slush-audio-cache') {}
  private db(): UseStore | undefined {
    if (typeof indexedDB === 'undefined') return undefined;
    return this.store ||= createStore(this.database, 'audio');
  }
  private digest(key: string): Promise<string> {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)).then(bytes=>Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join(''));
      this.hashes.set(key,hash);
      if(this.hashes.size>200)this.hashes.delete(this.hashes.keys().next().value!);
    }
    return hash;
  }
  private copy(value: StoredAudio): StoredAudio { return { ...value, words: value.words.map(word=>({...word})) }; }
  private enqueue(operation:()=>Promise<void>):Promise<void> {
    const task=this.writes.then(operation);this.writes=task.catch(()=>{});return task;
  }
  async get(key:string):Promise<StoredAudio|undefined> {
    await this.writes;
    const store=this.db();
    if(!store){const value=this.memory.get(key);return value?this.copy(value):undefined;}
    try {
      const hash=await this.digest(key),index=(await get<CacheIndex>('index',store))||{};
      const info=index[hash];
      if(!info)return undefined;
      if(Date.now()-info.savedAt>lifetime){await delMany([hash],store);return undefined;}
      const value=await get<StoredAudio>(hash,store);
      if(!value?.blob||typeof value.blob.size!=='number'||!Array.isArray(value.words))return undefined;
      await this.enqueue(async()=>{
        const latest=(await get<CacheIndex>('index',store))||{};
        if(latest[hash]){latest[hash].touchedAt=Math.max(Date.now(),...Object.values(latest).map(item=>item.touchedAt))+1;await setMany([['index',latest]],store);}
      });
      return value;
    }catch{return undefined;}
  }
  async set(key:string,value:StoredAudio,epoch=this.epoch):Promise<void> {
    const snapshot=this.copy(value);
    const store=this.db();
    if(!store){
      if(epoch!==this.epoch)return;
      this.memory.delete(key);this.memory.set(key,snapshot);
      while(this.memory.size>maxEntries)this.memory.delete(this.memory.keys().next().value!);
      return;
    }
    const hash=await this.digest(key);
    await this.enqueue(async()=>{
      if(epoch!==this.epoch)return;
      const index=(await get<CacheIndex>('index',store))||{};
      const now=Date.now(),touch=Math.max(now,...Object.values(index).map(item=>item.touchedAt))+1;
      // Rewrites of the same clip (duration, word timing) keep its original expiry.
      index[hash]={bytes:snapshot.blob.size,savedAt:index[hash]?.savedAt??now,touchedAt:touch};
      const keys=Object.keys(index).sort((a,b)=>index[b].touchedAt-index[a].touchedAt);
      let size=0,count=0;const evicted:string[]=[];
      for(const item of keys){
        if(now-index[item].savedAt>lifetime||count>=maxEntries||size+index[item].bytes>maxBytes){delete index[item];evicted.push(item);}
        else{size+=index[item].bytes;count++;}
      }
      await setMany([[hash,snapshot],['index',index]],store);
      if(evicted.length)await delMany(evicted,store);
    }).catch(()=>{});
  }
  async clear():Promise<void> {
    this.epoch++;this.memory.clear();this.hashes.clear();
    const store=this.db();if(store)await this.enqueue(()=>clear(store));
  }
}
