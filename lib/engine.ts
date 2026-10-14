import { analyze, clientFor, synthesize, transcribeWords } from './api';
import { buildChunks, locateTime } from './chunks';
import { PreparedCache, preparedKey } from './prepared-cache';
import { AudioCache } from './audio-cache';
import { alignWords, estimateWords, tokenize, wordAt } from './word-timing';
import { emptyState, friendlyError, type Chunk, type Control, type PageContent, type PlayerState, type Settings, type TranscriptWord } from './types';

interface AudioEntry {
  key: string; url: string; blob: Blob; text: string; language: string;
  words: TranscriptWord[]; timed: boolean; duration: number;
  alignment?: Promise<void>; alignmentController?: AbortController;
  alignmentAttempted?: boolean;
  cacheEpoch: number;
}
interface ResumePoint { word: number; ratio: number }

export class ReadingEngine {
  private audio = new Audio();
  private chunks: Chunk[] = [];
  private cache = new Map<string, Promise<AudioEntry>>();
  private ready = new Map<string, AudioEntry>();
  private urls = new Set<string>();
  private controller = new AbortController();
  private audioController = new AbortController();
  private metadataController = new AbortController();
  private generation = 0;
  private audioGeneration = 0;
  private playback = 0;
  private loadedIndex = -1;
  private offset = 0;
  private wanted = false;
  private entry?: AudioEntry;
  private resume?: ResumePoint;
  private tick?: ReturnType<typeof setInterval>;
  private lastPublished?: PlayerState;
  private state: PlayerState = { ...emptyState };
  private settings?: Settings;
  private page?: PageContent;
  private client?: ReturnType<typeof clientFor>;
  private prepared = new PreparedCache();
  private storedAudio: AudioCache;

  constructor(private publish: (state: PlayerState) => void, storedAudio = new AudioCache()) {
    this.storedAudio=storedAudio;
    this.audio.addEventListener('timeupdate', () => this.emit());
    this.audio.addEventListener('ended', () => {
      if (!this.wanted) return;
      if (this.state.index + 1 < this.chunks.length) void this.play(this.state.index + 1).catch(error => this.fail(error));
      else { this.state.status = 'ended'; this.wanted = false; this.stopClock(); this.emit(); }
    });
    this.audio.addEventListener('error', () => {
      if (this.loadedIndex >= 0) this.fail(new Error('Unable to play audio. Select Retry.'));
    });
  }

  snapshot(): PlayerState {
    const chunk = this.chunks[this.state.index];
    const elapsed = this.loadedIndex === this.state.index ? this.audio.currentTime || 0 : this.offset;
    const prefix = this.chunks.slice(0, this.state.index).reduce((sum, item) => sum + item.duration, 0);
    const duration = this.chunks.reduce((sum, item) => sum + item.duration, 0);
    const words = this.entry?.words || (chunk ? estimateWords(tokenize(chunk.text, this.state.language), chunk.duration) : []);
    const highlight = this.state.highlightWords && ['playing','paused'].includes(this.state.status);
    return { ...this.state, position: this.state.status === 'ended' ? duration : prefix + elapsed, duration,
      estimated: this.chunks.some(item => !item.exact), section: chunk?.section || '', transcript: chunk?.text || '',
      count: this.chunks.length, cached: this.urls.size, words, activeWord: highlight ? this.resume && this.loadedIndex < 0 ? this.resume.word : wordAt(words, elapsed) : -1,
      wordSync: !this.state.highlightWords ? 'off' : this.entry?.timed ? 'timed' : this.entry?.alignment ? 'pending' : 'estimated' };
  }
  private emit() {
    const next = this.snapshot();
    const old = this.lastPublished;
    // Sample media time frequently, but do not resend the transcript on every timer tick.
    if (old && old.status === next.status && old.index === next.index && old.voice === next.voice && old.activeWord === next.activeWord && old.wordSync === next.wordSync && old.speed === next.speed && old.highlightWords === next.highlightWords && old.cached === next.cached && Math.abs(old.position - next.position) < 0.2 && old.error === next.error && old.transcript === next.transcript
      && Math.abs(old.duration - next.duration) < 0.05 && old.estimated === next.estimated && old.section === next.section && old.count === next.count
      && old.title === next.title && old.textCached === next.textCached && old.words.length === next.words.length && old.words.at(-1)?.end === next.words.at(-1)?.end) return;
    this.lastPublished = next; this.publish(next);
  }
  private stopClock() { if (this.tick) clearInterval(this.tick); this.tick = undefined; }
  private startClock() { this.stopClock(); if (this.state.highlightWords) this.tick = setInterval(() => { if (this.state.status === 'playing') this.emit(); }, 60); }
  private fail(error: unknown) {
    if (this.controller.signal.aborted) return;
    if (this.loadedIndex === this.state.index) this.offset = this.audio.currentTime || 0;
    this.wanted = false; this.audio.pause(); this.stopClock(); this.state.status = 'error'; this.state.error = friendlyError(error); this.emit();
  }

  stop(publish = true) {
    this.generation++; this.audioGeneration++; this.playback++; this.wanted = false;
    this.controller.abort(); this.audioController.abort(); this.metadataController.abort(); this.stopClock();
    this.loadedIndex = -1; this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load();
    for (const record of this.ready.values()) record.alignmentController?.abort();
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear(); this.cache.clear(); this.ready.clear(); this.chunks = []; this.offset = 0;
    this.entry = undefined; this.resume = undefined; this.lastPublished = undefined;
    this.state = { ...emptyState }; if (publish) this.emit();
  }

  async start(page: PageContent, settings: Settings, tabId: number) {
    this.stop(false); this.controller = new AbortController(); this.audioController = new AbortController();
    this.page = page; this.settings = { ...settings };
    const generation = this.generation;
    this.state = { ...emptyState, status: 'analyzing', title: page.title, site: page.site, tabId, speed: settings.speed, voice: settings.voice, highlightWords: settings.highlightWords };
    this.wanted = true; this.emit();
    try {
      this.client = clientFor(settings);
      const key = await preparedKey(page);
      if (generation !== this.generation) return;
      const cached = await this.prepared.get(key);
      if (generation !== this.generation) return;
      const plan = cached?.plan || await analyze(this.client, page, this.controller.signal);
      if (generation !== this.generation) return;
      // Rebuild from current source and validated filters, never blindly trust cached prose.
      this.chunks = buildChunks(page, plan);
      this.state = { ...this.state, title: plan.title, pageType: plan.pageType, language: plan.language, textCached: Boolean(cached) };
      if (!cached) await this.prepared.set(key, { plan, savedAt: Date.now() });
      if (generation !== this.generation) return;
      await this.play(0);
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }

  private audioKey(index: number): string {
    const s = this.settings!;
    return JSON.stringify(['verbatim-audio-v1','gpt-4o-mini-tts', this.chunks[index].text, this.state.language, s.voice, s.style, s.instructions]);
  }
  private alignAudio(record: AudioEntry): Promise<void> {
    if (!this.settings?.highlightWords || record.timed) return Promise.resolve();
    if (record.alignment && !record.alignmentController?.signal.aborted) return record.alignment;
    if (record.alignmentAttempted && !record.alignmentController?.signal.aborted) return Promise.resolve();
    record.alignmentAttempted = true;
    const controller = new AbortController(); record.alignmentController = controller;
    const signal = this.audioController.signal;
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    const client = this.client!;
    const task = (async () => {
      try {
        const speech = await transcribeWords(client, record.blob, record.language, controller.signal);
        if (controller.signal.aborted) return;
        const aligned = alignWords(tokenize(record.text, record.language), speech);
        if (aligned.timed) { record.words = aligned.words; record.timed = true; await this.persistAudio(record); }
      } catch { /* Keep approximate highlighting if recognition is unavailable. */ }
      finally {
        signal.removeEventListener('abort', abort);
        if (record.alignmentController === controller) record.alignment = undefined;
        if (this.entry === record && !this.controller.signal.aborted) this.emit();
      }
    })();
    record.alignment = task; return task;
  }
  private async loadChunk(index: number): Promise<AudioEntry> {
    const key = this.audioKey(index);
    const existing = this.cache.get(key);
    if (existing) { this.cache.delete(key); this.cache.set(key, existing); return existing; }
    const generation = this.generation, audioGeneration = this.audioGeneration;
    const client = this.client!, settings = { ...this.settings! }, text = this.chunks[index].text, language = this.state.language;
    const signal = this.audioController.signal;
    let promise!: Promise<AudioEntry>;
    promise = (async () => {
      const saved=await this.storedAudio.get(key);
      if(generation!==this.generation||audioGeneration!==this.audioGeneration||signal.aborted)throw new DOMException('Cancelled','AbortError');
      const cacheEpoch=this.storedAudio.epoch;
      const blob = saved?.blob || await synthesize(client, text, settings, language, signal);
      if (generation !== this.generation || audioGeneration !== this.audioGeneration || signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (this.cache.get(key) !== promise) throw new DOMException('Evicted', 'AbortError');
      const url = URL.createObjectURL(blob); this.urls.add(url);
      const record: AudioEntry = { key, url, blob, text, language, words: saved?.words || tokenize(text,language), timed: saved?.timed || false, duration: saved?.duration || 0, cacheEpoch };
      this.ready.set(key, record);
      // Persist in the background; playback must not wait for IndexedDB.
      if(!saved)void this.persistAudio(record);
      for (const [oldKey] of this.cache) {
        if (this.cache.size <= 16) break;
        if (oldKey === key || oldKey === this.entry?.key) continue;
        const old = this.ready.get(oldKey);
        this.cache.delete(oldKey); this.ready.delete(oldKey);
        if (old) { old.alignmentController?.abort(); this.urls.delete(old.url); URL.revokeObjectURL(old.url); }
      }
      this.emit(); return record;
    })();
    this.cache.set(key, promise);
    void promise.catch(() => { if (this.cache.get(key) === promise) this.cache.delete(key); });
    return promise;
  }

  private persistAudio(record:AudioEntry):Promise<void> {
    return this.storedAudio.set(record.key,{blob:record.blob,text:record.text,language:record.language,words:record.words,timed:record.timed,duration:record.duration},record.cacheEpoch);
  }

  private async play(index: number, offset = 0, resume?: ResumePoint) {
    if (!this.chunks[index]) return;
    const ticket = ++this.playback, generation = this.generation, audioGeneration = this.audioGeneration;
    this.metadataController.abort(); this.metadataController = new AbortController();
    const metadataSignal = this.metadataController.signal;
    const isCurrent = () => ticket === this.playback && generation === this.generation && audioGeneration === this.audioGeneration;
    try {
      this.audio.pause(); this.stopClock(); this.loadedIndex = -1; this.entry = undefined;
      this.state.index = index; this.offset = offset;
      this.state.status = this.wanted ? 'buffering' : 'paused'; this.state.error = ''; this.emit();
      const record = await this.loadChunk(index);
      if (!isCurrent()) return;
      this.entry = record; this.audio.src = record.url;
      await new Promise<void>((resolve, reject) => {
        const clean = () => { this.audio.removeEventListener('loadedmetadata', loaded); this.audio.removeEventListener('error', failed); metadataSignal.removeEventListener('abort', aborted); };
        const loaded = () => { clean(); resolve(); };
        const failed = () => { clean(); reject(new Error('Unable to load audio. Try reading again.')); };
        const aborted = () => { clean(); reject(new DOMException('Cancelled', 'AbortError')); };
        this.audio.addEventListener('loadedmetadata', loaded, { once: true }); this.audio.addEventListener('error', failed, { once: true });
        metadataSignal.addEventListener('abort', aborted, { once: true }); this.audio.load();
      });
      if (!isCurrent()) return;
      if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
        // Only a newly measured duration needs to be stored; replays keep the cached entry as is.
        const measured = Math.abs(record.duration - this.audio.duration) > 0.001;
        record.duration = this.audio.duration;
        this.chunks[index].duration = record.duration; this.chunks[index].exact = true;
        if (measured) {
          if (!record.timed) record.words = estimateWords(tokenize(record.text,record.language),record.duration);
          void this.persistAudio(record);
        }
      }
      if (resume && this.settings?.highlightWords) await this.alignAudio(record);
      if (!isCurrent()) return;
      const position = resume ? (record.words[resume.word]?.start ?? record.duration * resume.ratio) : offset;
      this.loadedIndex = index; this.audio.currentTime = Math.min(position, Math.max(0, record.duration - 0.05));
      this.offset = this.audio.currentTime; this.resume = undefined; this.audio.playbackRate = this.state.speed;
      if (this.wanted) { await this.audio.play(); if (!isCurrent()) return; this.state.status = 'playing'; this.startClock(); }
      else this.state.status = 'paused';
      this.emit();
      if (this.wanted) {
        void this.alignAudio(record);
        if (index + 1 < this.chunks.length) void this.loadChunk(index + 1).catch(() => {});
      }
    } catch (error) { if (isCurrent()) throw error; }
  }

  async applySettings(next: Settings) {
    try {
    const previous = this.settings;
    if (!next.apiKey.trim()) { this.stop(); this.settings = { ...next }; this.client = undefined; return; }
    const changed = Boolean(previous && (previous.voice !== next.voice || previous.style !== next.style || previous.instructions !== next.instructions || previous.apiKey !== next.apiKey));
    this.settings = { ...next }; this.client = clientFor(next);
    this.state.speed = next.speed; this.state.voice = next.voice; this.state.highlightWords = next.highlightWords;
    this.audio.playbackRate = next.speed;
    if (!next.highlightWords) { this.stopClock(); for (const entry of this.ready.values()) if(entry.alignment)entry.alignmentController?.abort(); }
    else if (this.state.status === 'playing' && !changed) { this.startClock(); if (this.entry) void this.alignAudio(this.entry); }
    if (!previous || this.state.status === 'idle') { this.emit(); return; }
    if (!changed) { this.emit(); return; }
    if (this.state.status === 'analyzing') {
      if (previous.apiKey !== next.apiKey && this.page && this.state.tabId !== null) await this.start(this.page,next,this.state.tabId);
      else this.emit();
      return;
    }
    if (!this.chunks.length || this.state.status === 'ended') { this.emit(); return; }
    const index = this.state.index;
    const elapsed = this.loadedIndex === index ? this.audio.currentTime || 0 : this.offset;
    const words = this.entry?.words || estimateWords(tokenize(this.chunks[index].text,this.state.language),this.chunks[index].duration);
    let word = wordAt(words,elapsed);
    if (word < 0) word = words.findIndex(item => item.end > elapsed);
    if (word < 0) word = Math.max(0,words.length-1);
    const resume = this.resume || { word: Math.max(0,word), ratio: this.chunks[index].duration ? elapsed / this.chunks[index].duration : 0 };
    this.audio.pause(); this.stopClock(); this.audioGeneration++; this.playback++; this.metadataController.abort();
    this.audioController.abort(); this.audioController = new AbortController();
    for (const [key] of this.cache) if (!this.ready.has(key)) this.cache.delete(key);
    for (const record of this.ready.values()) {
      if(record.alignment)record.alignmentController?.abort();
      if(previous.apiKey!==next.apiKey)record.alignmentAttempted=false;
    }
    this.loadedIndex = -1; this.entry = undefined; this.resume = resume; this.offset = elapsed;
    this.audio.removeAttribute('src'); this.audio.load();
    for (let i=index;i<this.chunks.length;i++) { this.chunks[i].duration=Math.max(1.5,this.chunks[i].text.length/14);this.chunks[i].exact=false; }
    this.state.status = this.wanted ? 'buffering' : 'paused'; this.emit();
    if (this.wanted) await this.play(index,this.offset,resume);
    } catch(error) { this.fail(error); }
  }

  clearPreparedCache() { this.prepared.clearMemory(); }
  async clearAudioCache() {
    await this.storedAudio.clear();
    for(const [key,record]of this.ready){
      if(record===this.entry)continue;
      record.alignmentController?.abort();this.ready.delete(key);this.cache.delete(key);
      this.urls.delete(record.url);URL.revokeObjectURL(record.url);
    }
    for(const [key]of this.cache)if(!this.ready.has(key))this.cache.delete(key);
    this.emit();
  }

  async control(control: Control) {
    try {
      if (control.action === 'stop') { this.stop(); return; }
      if (control.action === 'retry') {
        if (this.chunks.length) { this.wanted = true; await this.play(this.state.index,this.offset,this.resume); }
        else if (this.page && this.settings && this.state.tabId !== null) await this.start(this.page,this.settings,this.state.tabId);
        return;
      }
      if (control.action === 'speed') {
        if (!Number.isFinite(control.speed)) return;
        this.state.speed=Math.min(2,Math.max(0.5,control.speed)); if(this.settings)this.settings.speed=this.state.speed;
        this.audio.playbackRate=this.state.speed;this.emit();return;
      }
      if (control.action === 'toggle') {
        if (this.wanted) { this.wanted=false;this.audio.pause();this.stopClock();if(this.state.status!=='analyzing')this.state.status='paused';this.emit(); }
        else {
          this.wanted=true;if(this.state.status==='analyzing')return;
          if(this.state.status==='ended')await this.play(0);
          else if(this.loadedIndex===this.state.index&&this.audio.src){await this.audio.play();this.state.status='playing';this.startClock();if(this.entry)void this.alignAudio(this.entry);this.emit();}
          else await this.play(this.state.index,this.offset,this.resume);
        }
        return;
      }
      if(!this.chunks.length)return;
      const position=control.action==='skip'?this.snapshot().position+control.seconds:control.position;
      if(!Number.isFinite(position))return;
      this.resume=undefined;
      const target=locateTime(this.chunks,position);
      if(target.index===this.loadedIndex&&this.state.index===this.loadedIndex){this.audio.currentTime=target.offset;if(this.state.status==='ended')this.state.status='paused';this.emit();}
      else await this.play(target.index,target.offset);
    } catch(error){this.fail(error);}
  }
}
