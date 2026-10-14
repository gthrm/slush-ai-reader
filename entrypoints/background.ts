import { defineBackground } from 'wxt/utils/define-background';
import { AudioCache } from '../lib/audio-cache';
import { emptyState, friendlyError, settingsSchema, readStoredSettings, planSchema, type PlayerState, type Reply, type PreparedReading } from '../lib/types';

export default defineBackground(() => {
  let creating: Promise<void> | undefined;
  let latest: PlayerState = { ...emptyState };
  // False until the offscreen engine has reported its state to this service worker instance.
  let latestKnown = false;
  let pending: PlayerState | undefined;
  let startRevision = 0;
  // Tabs inside startTab, so a reader injected by the start does not register a dock over it.
  const starting = new Set<number>();
  const docks = new Map<number, PlayerState>();
  const restoredDocks = chrome.storage.session.get('docks').then(stored => {
    for (const [id, state] of Object.entries(stored.docks || {})) docks.set(Number(id), state as PlayerState);
  });
  function persistDocks() { return chrome.storage.session.set({ docks: Object.fromEntries(docks) }); }
  async function attachToTab(tabId: number, force = false) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab?.url || !/^https?:\/\//.test(tab.url)) return;
    // Leave an existing reader alone, including one the user has minimized or closed.
    if (!force) {
      try { const reply = await chrome.tabs.sendMessage(tabId, { type: 'PING' }); if (reply?.ok) return; } catch {}
    }
    try {
      // A previous unpacked build can leave DOM and globals behind after reload.
      await chrome.scripting.executeScript({ target: { tabId }, func: () => {
        const reader = globalThis as typeof globalThis & { __slushReader?: boolean; __slushDispose?: () => void };
        try { reader.__slushDispose?.(); } catch { /* The old extension context may already be invalid. */ }
        reader.__slushReader = false;
        document.getElementById('slush-reader-host')?.remove();
      } });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/reader.js'] });
    }
    catch { /* Browser-controlled pages and withheld site permissions cannot be injected. */ }
  }
  async function attachToOpenTabs(force = false) {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    await Promise.allSettled(tabs.filter(tab => tab.id !== undefined && tab.status !== 'loading').map(tab => attachToTab(tab.id!, force)));
  }
  async function readerMetadata(tabId: number): Promise<{ title: string; url: string }> {
    try { const reply = await chrome.tabs.sendMessage(tabId, { type: 'PING' }); if (reply?.ok) return reply; } catch {}
    try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/reader.js'] }); }
    catch { throw new Error('This page does not allow extensions. Try another website.'); }
    return chrome.tabs.sendMessage(tabId, { type: 'PING' });
  }
  async function openSettings(tabId: number, focusKey = false) {
    if (focusKey) await chrome.storage.session.set({ keySetupTabId: tabId });
    const tab = await chrome.tabs.get(tabId);
    try { await chrome.action.openPopup({ windowId: tab.windowId }); }
    catch { await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') }); }
  }
  // API keys are only visible to extension pages, never to injected content scripts.
  const restrictedStorage = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  async function settings() {
    await restrictedStorage;
    const stored = await chrome.storage.local.get('settings');
    return readStoredSettings(stored.settings);
  }
  async function ensureOffscreen() {
    if (await chrome.offscreen.hasDocument()) return;
    if (!creating) creating = chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: [chrome.offscreen.Reason.BLOBS],
      justification: 'Create and retain Blob URLs for generated speech, including paused audio and seekable chunk cache.',
    }).finally(() => { creating = undefined; });
    await creating;
  }
  async function getState() {
    if (pending) return pending;
    if (!await chrome.offscreen.hasDocument()) { latest = { ...emptyState }; latestKnown = false; return latest; }
    // STATE broadcasts keep `latest` current; ask the engine only after a service worker restart.
    if (latestKnown) return latest;
    const reply: Reply | undefined = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'GET_STATE' }).catch(() => undefined);
    if (reply?.state) { latest = reply.state; latestKnown = true; }
    return latest;
  }
  async function leaveTab(tabId: number) {
    docks.delete(tabId); await persistDocks();
    const state = await getState();
    if (state.tabId === tabId) await stopReading();
  }
  async function stopReading() {
    startRevision++;
    const pendingTab = pending?.tabId;
    pending = undefined;
    if (pendingTab !== undefined && pendingTab !== null) await chrome.tabs.sendMessage(pendingTab, { type: 'HIDE_PLAYER' }).catch(() => {});
    if (await chrome.offscreen.hasDocument()) await chrome.runtime.sendMessage({ target: 'offscreen', type: 'CONTROL', control: { action: 'stop' } });
  }
  async function showTab(tabId: number, source?: { title: string; url: string }): Promise<Reply> {
    if (!Number.isInteger(tabId)) throw new Error('No active tab found.');
    const tab = await chrome.tabs.get(tabId);
    const meta = source || await readerMetadata(tabId);
    if (!/^https?:\/\//.test(meta.url)) throw new Error('Open a regular web page to use the player.');
    const active = await getState();
    let state = active.tabId === tabId ? active : undefined;
    if (!state || state.status === 'idle') {
      const current = await settings();
      if (starting.has(tabId)) return { ok: true, state: pending?.tabId === tabId ? pending : undefined };
      state = { ...emptyState, status: 'ready', title: meta.title || tab.title || 'This page', site: new URL(meta.url).hostname, tabId, speed: current.speed, voice: current.voice, highlightWords: current.highlightWords };
      docks.set(tabId, state); await persistDocks();
    }
    await chrome.tabs.sendMessage(tabId, { type: 'SHOW_PLAYER', state });
    return { ok: true, state };
  }
  async function startTab(tabId: number): Promise<Reply> {
    if (!Number.isInteger(tabId)) throw new Error('No active tab found.');
    starting.add(tabId);
    try { return await startTabInner(tabId); }
    finally { starting.delete(tabId); }
  }
  async function startTabInner(tabId: number): Promise<Reply> {
    const revision = ++startRevision;
    const tab = await chrome.tabs.get(tabId);
    const meta = await readerMetadata(tabId);
    if (!/^https?:\/\//.test(meta.url)) throw new Error('Open a regular web page. Browser system pages cannot be read.');
    const current = await settings();
    if (!current.apiKey.trim()) {
      await openSettings(tabId, true);
      throw new Error('Enter your OpenAI API key in Settings → OpenAI API key. Save it to start reading.');
    }
    if (revision !== startRevision) return { ok: true };
    docks.delete(tabId); await persistDocks();
    const previousPendingTab = pending?.tabId;
    pending = { ...emptyState, status: 'preparing', title: meta.title || tab.title || 'This page', site: new URL(meta.url).hostname, tabId, speed: current.speed };
    if (previousPendingTab !== undefined && previousPendingTab !== null && previousPendingTab !== tabId) void chrome.tabs.sendMessage(previousPendingTab, { type: 'HIDE_PLAYER' }).catch(() => {});
    try {
      // Paint the player before extraction, offscreen creation, or any API work.
      await chrome.tabs.sendMessage(tabId, { type: 'SHOW_PLAYER', state: pending });
      if (revision !== startRevision) return { ok: true };
      if (await chrome.offscreen.hasDocument()) await chrome.runtime.sendMessage({ target: 'offscreen', type: 'CONTROL', control: { action: 'stop' } });
      if (revision !== startRevision) return { ok: true };
      const extracted = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE' });
      if (revision !== startRevision) return { ok: true };
      if (!extracted.ok) throw new Error(extracted.error);
      await ensureOffscreen();
      if (revision !== startRevision) return { ok: true };
      pending = undefined;
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'START', page: extracted.page, settings: await settings(), tabId });
      return { ok: true };
    } catch (error) {
      if (revision === startRevision) {
        pending = { ...emptyState, status: 'error', title: meta.title || tab.title || 'This page', site: new URL(meta.url).hostname, tabId, speed: current.speed, error: friendlyError(error) };
        await chrome.tabs.sendMessage(tabId, { type: 'PLAYER_STATE', state: pending }).catch(() => {});
        throw error;
      }
      return { ok: true };
    }
  }
  async function handle(message: any, sender: chrome.runtime.MessageSender): Promise<Reply> {
    await restoredDocks;
    if (sender.id !== chrome.runtime.id) throw new Error('Access denied.');
    // Internal extension pages can also be opened as browser tabs during development.
    const trustedPage = sender.url === chrome.runtime.getURL('popup.html') || sender.url === chrome.runtime.getURL('offscreen.html');
    const fromTab = trustedPage ? undefined : sender.tab?.id;
    if (!trustedPage && fromTab === undefined) throw new Error('Access denied.');
    if (message.type === 'INIT_DOCK' && fromTab !== undefined) return showTab(fromTab, { title: String(message.title || 'This page'), url: sender.url || '' });
    if (message.type === 'PAGE_HIDE' && fromTab !== undefined) { await leaveTab(fromTab); return { ok: true }; }
    if (message.type === 'OPEN_SETTINGS' && fromTab !== undefined) { await openSettings(fromTab); return { ok: true }; }
    if (message.type === 'CLOSE_POPUP') {
      void chrome.runtime.sendMessage({ target: 'popup', type: 'CLOSE' }).catch(() => {});
      return { ok: true };
    }
    if (message.type === 'STATE') {
      if (sender.url !== chrome.runtime.getURL('offscreen.html')) throw new Error('Access denied.');
      const oldTab = latest.tabId; latest = message.state; latestKnown = true;
      const tabs = new Set([oldTab, latest.tabId, pending?.tabId].filter((id): id is number => id !== null && id !== undefined));
      for (const id of tabs) void chrome.tabs.sendMessage(id, { type: 'PLAYER_STATE', state: pending?.tabId === id ? pending : latest.tabId === id ? latest : docks.get(id) || emptyState }).catch(() => {});
      return { ok: true };
    }
    if (message.type === 'GET_STATE') {
      const state = await getState();
      const tabId = fromTab ?? message.tabId;
      return { ok: true, state: tabId === undefined || state.tabId === tabId ? state : docks.get(tabId) || { ...emptyState } };
    }
    if (message.type === 'CONTROL') {
      const state = await getState();
      const tabId = fromTab ?? message.tabId ?? state.tabId;
      const dock = tabId === null ? undefined : docks.get(tabId);
      if (dock && (message.control?.action === 'toggle' || message.control?.action === 'retry')) {
        try { return await startTab(tabId); }
        catch (error) {
          const failed = { ...dock, status: 'error' as const, error: friendlyError(error) };
          docks.set(tabId, failed); await persistDocks();
          await chrome.tabs.sendMessage(tabId, { type: 'PLAYER_STATE', state: failed }).catch(() => {});
          throw error;
        }
      }
      if (dock && message.control?.action === 'stop') {
        docks.delete(tabId); await persistDocks();
        await chrome.tabs.sendMessage(tabId, { type: 'HIDE_PLAYER' }).catch(() => {});
        return { ok: true };
      }
      if (fromTab !== undefined && fromTab !== state.tabId && !dock) throw new Error('Reading is active in another tab.');
      if (message.control?.action === 'stop') { await stopReading(); return { ok: true }; }
      if (pending && message.control?.action === 'retry' && pending.tabId !== null) return startTab(pending.tabId);
      if (message.control?.action === 'speed') {
        const current = await settings();
        const next = settingsSchema.parse({ ...current, speed: message.control.speed });
        await chrome.storage.local.set({ settings: next });
        if (dock) {
          dock.speed = next.speed; await persistDocks();
          await chrome.tabs.sendMessage(tabId, { type: 'PLAYER_STATE', state: dock }).catch(() => {});
          return { ok: true };
        }
        if (pending) {
          pending.speed = next.speed;
          if (pending.tabId !== null) await chrome.tabs.sendMessage(pending.tabId, { type: 'PLAYER_STATE', state: pending }).catch(() => {});
        }
      }
      if (pending) return { ok: true };
      if (await chrome.offscreen.hasDocument()) await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
      return { ok: true };
    }
    if (fromTab !== undefined) throw new Error('Settings are only available from the extension popup.');
    if (message.type === 'GET_PREPARED' || message.type === 'SAVE_PREPARED') {
      if (typeof message.key !== 'string' || !/^[a-f0-9]{64}$/.test(message.key)) throw new Error('Invalid cache key.');
      await restrictedStorage;
      const stored = await chrome.storage.local.get('preparedPages');
      const pages: Record<string, PreparedReading> = {};
      // Older builds also stored chunk text; keep only the plan.
      for (const [key, value] of Object.entries((stored.preparedPages || {}) as Record<string, PreparedReading>)) {
        if (Date.now() - value.savedAt <= 7 * 24 * 60 * 60 * 1000) pages[key] = { plan: value.plan, savedAt: value.savedAt };
      }
      if (message.type === 'GET_PREPARED') return { ok: true, prepared: pages[message.key] };
      const plan = planSchema.parse(message.prepared?.plan);
      if (JSON.stringify(plan).length > 300_000) throw new Error('Invalid cached text.');
      pages[message.key] = { plan, savedAt: Date.now() };
      const keys = Object.keys(pages).sort((a,b)=>pages[b].savedAt-pages[a].savedAt);
      let bytes=0;
      for (let i=0;i<keys.length;i++) { bytes += new TextEncoder().encode(JSON.stringify(pages[keys[i]])).length; if(i>=10||bytes>2_000_000)delete pages[keys[i]]; }
      await chrome.storage.local.set({ preparedPages: pages });
      return { ok: true };
    }
    if (message.type === 'CLEAR_PREPARED') {
      await chrome.storage.local.remove('preparedPages');
      if (await chrome.offscreen.hasDocument()) await chrome.runtime.sendMessage({ target: 'offscreen', type: 'CLEAR_PREPARED' });
      return { ok: true };
    }
    if(message.type==='CLEAR_AUDIO'){
      if(await chrome.offscreen.hasDocument())return chrome.runtime.sendMessage({target:'offscreen',type:'CLEAR_AUDIO'});
      await new AudioCache().clear();return {ok:true};
    }
    if (message.type === 'ATTACH_OPEN_TABS') { await attachToOpenTabs(); return { ok: true }; }
    if (message.type === 'GET_SETTINGS') {
      const setup = await chrome.storage.session.get('keySetupTabId');
      await chrome.storage.session.remove('keySetupTabId');
      const setupTabId = typeof setup.keySetupTabId === 'number' ? setup.keySetupTabId : undefined;
      return { ok: true, settings: await settings(), focusApiKey: setupTabId !== undefined, tabId: setupTabId };
    }
    if (message.type === 'SAVE_SETTINGS') {
      await restrictedStorage;
      const next = settingsSchema.parse(message.settings);
      await chrome.storage.local.set({ settings: next });
      for (const [tabId, dock] of docks) {
        const ready = { ...dock, status: 'ready' as const, error: '', speed: next.speed, voice: next.voice, highlightWords: next.highlightWords };
        docks.set(tabId, ready);
        void chrome.tabs.sendMessage(tabId, { type: 'PLAYER_STATE', state: ready }).catch(() => {});
      }
      await persistDocks();
      if (await chrome.offscreen.hasDocument()) await chrome.runtime.sendMessage({ target: 'offscreen', type: 'UPDATE_SETTINGS', settings: next });
      return { ok: true };
    }
    if (message.type === 'OPEN_TAB') return showTab(message.tabId);
    if (message.type === 'START_TAB') return startTab(message.tabId);
    throw new Error('Unknown command.');
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.target !== 'background') return;
    void handle(message, sender).then(reply).catch(error => reply({ ok: false, error: friendlyError(error) }));
    return true;
  });
  chrome.commands.onCommand.addListener(() => { void getState().then(state => { if (!pending && state.tabId !== null) return chrome.runtime.sendMessage({ target: 'offscreen', type: 'CONTROL', control: { action: 'toggle' } }); }).catch(() => {}); });
  chrome.runtime.onInstalled.addListener(() => { void attachToOpenTabs(true).catch(() => {}); });
  chrome.runtime.onStartup.addListener(() => { void attachToOpenTabs(true).catch(() => {}); });
  chrome.permissions.onAdded.addListener(() => { void attachToOpenTabs().catch(() => {}); });
  chrome.tabs.onRemoved.addListener(id => { void restoredDocks.then(() => leaveTab(id)).catch(() => {}); });
  chrome.tabs.onUpdated.addListener((id, change) => {
    // Same-document navigations (pushState) also report 'loading'; a reader that still answers was not unloaded.
    // A real navigation is also reported by the reader's PAGE_HIDE.
    if (change.status === 'loading') void restoredDocks.then(async () => {
      const alive = await chrome.tabs.sendMessage(id, { type: 'PING' }).then(reply => Boolean(reply?.ok), () => false);
      if (!alive) await leaveTab(id);
    }).catch(() => {});
    if (change.status === 'complete') void attachToTab(id);
  });
});
