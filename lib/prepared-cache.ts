import { planSchema, type PageContent, type PreparedReading, type Reply } from './types';

export async function preparedKey(page: PageContent): Promise<string> {
  const url = new URL(page.url || 'https://local.invalid'); url.hash = '';
  const input = JSON.stringify({ version: 'source-reader-v2', model: 'gpt-4.1-mini', url: url.href, title: page.title, language: page.language, extraction: page.extraction, blocks: page.blocks });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class PreparedCache {
  private memory = new Map<string, PreparedReading>();
  clearMemory() { this.memory.clear(); }
  async get(key: string): Promise<PreparedReading | undefined> {
    let value = this.memory.get(key);
    if (!value && typeof chrome !== 'undefined' && chrome.runtime?.id) {
      const reply: Reply = await chrome.runtime.sendMessage({ target: 'background', type: 'GET_PREPARED', key }).catch(() => ({ ok: false }));
      value = reply?.prepared;
    }
    if (!value || Date.now() - value.savedAt > 7 * 24 * 60 * 60 * 1000) return undefined;
    if (!planSchema.safeParse(value.plan).success) return undefined;
    this.memory.set(key, value); return structuredClone(value);
  }
  async set(key: string, value: PreparedReading) {
    this.memory.delete(key); this.memory.set(key, structuredClone(value));
    while (this.memory.size > 10) this.memory.delete(this.memory.keys().next().value!);
    if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
      await chrome.runtime.sendMessage({ target: 'background', type: 'SAVE_PREPARED', key, prepared: value }).catch(() => {});
    }
  }
}
