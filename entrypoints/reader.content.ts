import { defineContentScript } from 'wxt/utils/define-content-script';
import { extractPage } from '../lib/extract';
import { icon } from '../lib/icons';
import { emptyState, formatTime, friendlyError, type Control, type PlayerState } from '../lib/types';
import css from '../lib/player.css?inline';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  main() {
    // Repeated action clicks must not register multiple players or listeners.
    const shared = globalThis as typeof globalThis & { __slushReader?: boolean; __slushDispose?: () => void };
    if (shared.__slushReader) return;
    shared.__slushReader = true;
    let state: PlayerState = { ...emptyState };
    let host: HTMLElement | undefined;
    let shadow: ShadowRoot | undefined;
    let expanded = false;
    let minimized = true;
    let collapsed = false;
    let scrubbing = false;
    let preparing = false;
    let revision = 0;
    let renderedText = '';
    let wordNodes: HTMLElement[] = [];
    let highlightedWord = -1;
    let expandedByUser = false;
    function el<T extends HTMLElement = HTMLElement>(id: string) { return shadow!.getElementById(id) as T; }
    function send(control: Control) {
      void chrome.runtime.sendMessage({ target: 'background', type: 'CONTROL', control }).then(reply => {
        if (!reply.ok && shadow) el('status').textContent = reply.error;
      }).catch(() => { if (shadow) el('status').textContent = 'The extension was updated. Reload this page.'; });
    }
    function mount() {
      renderedText = ''; wordNodes = []; highlightedWord = -1;
      host = document.createElement('div'); host.id = 'slush-reader-host';
      host.style.cssText = 'all:initial;position:fixed;inset:auto 16px 20px;z-index:2147483647;display:block;pointer-events:none;color-scheme:dark;';
      shadow = host.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `<style>${css}</style>
      <section class="player" aria-label="Slush — reading player">
        <div id="mini-player" class="mini-player" hidden><button id="restore" class="restore" aria-label="Restore player">${icon('audio',18)}<span>slush</span></button><button id="mini-toggle" class="mini-play" aria-label="Read this page">${icon('play',18)}</button><button id="mini-settings" class="quiet" aria-label="Open voice and API key settings">${icon('settings',16)}</button><button id="mini-minimize" class="quiet" aria-label="Minimize player">${icon('minimize',16)}</button></div>
        <div class="transcript" id="transcript-panel" hidden><div class="transcript-heading"><span>NOW READING</span><span id="word-sync"></span><span id="fragment"></span></div><p id="transcript"></p></div>
        <div class="progress-line"><input id="timeline" type="range" min="0" max="1" step="0.1" value="0" aria-label="Reading position"></div>
        <div class="body">
          <div class="brand" aria-hidden="true">${icon('audio', 22)}</div>
          <div class="info"><div class="topline"><span class="wordmark">slush</span><span class="dot"></span><span id="site"></span><span class="ai" id="voice-label"></span></div><div id="title" class="title"></div><div id="status" class="status" role="status" aria-live="polite"></div></div>
          <div class="controls"><button id="back" class="skip" aria-label="Back 15 seconds">${icon('back')}<span>15</span></button><button id="toggle" class="play" aria-label="Pause">${icon('pause')}</button><button id="forward" class="skip" aria-label="Forward 15 seconds">${icon('forward')}<span>15</span></button></div>
          <div class="time"><span id="position">0:00</span><span class="divider"> / </span><span id="duration">0:00</span></div>
          <select id="speed" aria-label="Playback speed"><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option><option value="2">2×</option></select>
          <button id="expand" class="quiet" aria-label="Show transcript" aria-expanded="false">${icon('up',18)}</button><button id="settings" class="quiet" aria-label="Open voice and API key settings">${icon('settings',18)}</button><button id="minimize" class="quiet" aria-label="Minimize player and close settings">${icon('minimize',18)}</button><button id="close" class="quiet" aria-label="Stop reading and close the player">${icon('close',18)}</button>
        </div>
      </section>`;
      document.documentElement.append(host);
      el('toggle').addEventListener('click', () => send({ action: state.status === 'error' ? 'retry' : 'toggle' }));
      el('mini-toggle').addEventListener('click', () => send({ action: state.status === 'error' ? 'retry' : 'toggle' }));
      for (const id of ['mini-settings','settings']) el(id).addEventListener('click', () => { void chrome.runtime.sendMessage({ target: 'background', type: 'OPEN_SETTINGS' }).catch(() => {}); });
      el('mini-minimize').addEventListener('click', () => { collapsed = true; updateSize(); void chrome.runtime.sendMessage({ target: 'background', type: 'CLOSE_POPUP' }).catch(() => {}); });
      el('minimize').addEventListener('click', () => {
        minimized = true; collapsed = false; updateSize();
        void chrome.runtime.sendMessage({ target: 'background', type: 'CLOSE_POPUP' }).catch(() => {});
      });
      el('restore').addEventListener('click', () => { collapsed = false; minimized = state.status === 'ready' || (state.status === 'error' && !state.count); updateSize(); });
      el('back').addEventListener('click', () => send({ action: 'skip', seconds: -15 }));
      el('forward').addEventListener('click', () => send({ action: 'skip', seconds: 15 }));
      el('close').addEventListener('click', () => { send({ action: 'stop' }); preparing = false; render({ ...emptyState }); });
      el('speed').addEventListener('change', () => send({ action: 'speed', speed: Number(el<HTMLSelectElement>('speed').value) }));
      el('expand').addEventListener('click', () => {
        expandedByUser = true;
        expanded = !expanded; updateSize();
        el('expand').setAttribute('aria-expanded', String(expanded));
        el('expand').setAttribute('aria-label', expanded ? 'Hide transcript' : 'Show transcript');
        el('expand').innerHTML = icon(expanded ? 'down' : 'up');
      });
      el('timeline').addEventListener('input', () => { scrubbing = true; el('position').textContent = formatTime(Number(el<HTMLInputElement>('timeline').value)); });
      el('timeline').addEventListener('change', () => { scrubbing = false; send({ action: 'seek', position: Number(el<HTMLInputElement>('timeline').value) }); });
    }
    function updateSize() {
      if (!shadow) return;
      shadow.querySelector('.player')!.classList.toggle('minimized', minimized);
      shadow.querySelector('.player')!.classList.toggle('collapsed', collapsed);
      el('mini-player').hidden = !minimized;
      el('transcript-panel').hidden = minimized || !expanded;
      el('expand').setAttribute('aria-expanded',String(expanded));
      el('expand').setAttribute('aria-label',expanded?'Hide transcript':'Show transcript');
      if(el('expand').dataset.expanded!==String(expanded)){el('expand').innerHTML=icon(expanded?'down':'up',18);el('expand').dataset.expanded=String(expanded);}
    }
    function renderTranscript() {
      const text = state.transcript || (state.status === 'ready' ? 'Press Play to read this page. Select text first to read just a passage.' : 'Understanding the page and preparing to read…');
      const container = el('transcript');
      if(text!==renderedText || wordNodes.length!==state.words.length){
        renderedText=text;wordNodes=[];highlightedWord=-1;
        const fragment=document.createDocumentFragment();let offset=0;
        for(const word of state.words){
          fragment.append(document.createTextNode(text.slice(offset,word.from)));
          const span=document.createElement('span');span.className='transcript-word';span.textContent=text.slice(word.from,word.to);
          fragment.append(span);wordNodes.push(span);offset=word.to;
        }
        fragment.append(document.createTextNode(text.slice(offset)));container.replaceChildren(fragment);container.scrollTop=0;
      }
      const active=state.highlightWords?state.activeWord:-1;
      if(active!==highlightedWord){
        wordNodes[highlightedWord]?.classList.remove('current-word');wordNodes[highlightedWord]?.removeAttribute('aria-current');
        const current=wordNodes[active];current?.classList.add('current-word');current?.setAttribute('aria-current','true');
        highlightedWord=active;
        if(current&&expanded&&!minimized){
          const bounds=container.getBoundingClientRect(),word=current.getBoundingClientRect();
          if(word.bottom>bounds.bottom-8)container.scrollTop+=word.bottom-bounds.bottom+8;
          else if(word.top<bounds.top+8)container.scrollTop+=word.top-bounds.top-8;
        }
      }
      const sync=state.wordSync==='pending'?'Syncing words…':state.wordSync==='estimated'?'Approximate timing':state.wordSync==='timed'?'Synced to audio':'';
      el('word-sync').textContent=state.highlightWords&&state.count?sync:'';
    }
    function render(next: PlayerState) {
      if (preparing && next.status === 'idle') return;
      if (next.status !== 'preparing' && next.status !== 'idle') preparing = false;
      if(next.status==='playing'&&next.highlightWords&&!expandedByUser)expanded=true;
      if (['ready','idle'].includes(state.status) && ['preparing','analyzing','buffering','playing'].includes(next.status)) { minimized = false; collapsed = false; }
      state = next;
      if (state.status === 'idle') { host?.remove(); host = undefined; shadow = undefined; return; }
      if (!host) mount();
      updateSize();
      el('title').textContent = state.title;
      el('restore').title = state.error || `${state.title} · ${state.voice}`;
      el('site').textContent = state.site;
      renderTranscript();
      el('voice-label').textContent=state.voice?state.voice[0].toUpperCase()+state.voice.slice(1):'';
      el('fragment').textContent = state.count ? `${state.index + 1} / ${state.count}` : '';
      const statuses = { ready: 'Ready to listen · select text to read a passage', preparing: 'Preparing this page…', analyzing: 'Understanding the page…', buffering: 'Preparing audio…', playing: state.section && state.section !== state.title ? state.section : 'Reading', paused: 'Paused', ended: 'Finished. Listen again whenever you like.', error: state.error, idle: '' };
      const status = el('status');
      if (status.textContent !== statuses[state.status]) status.textContent = statuses[state.status];
      status.classList.toggle('error', state.status === 'error');
      const busy = state.status === 'preparing' || state.status === 'analyzing' || state.status === 'buffering';
      const playing = state.status === 'playing';
      const toggle = el<HTMLButtonElement>('toggle');
      const mode = state.status === 'error' ? 'retry' : busy ? 'loading' : playing ? 'pause' : 'play';
      if (toggle.dataset.mode !== mode) { toggle.innerHTML = icon(mode, 23); toggle.dataset.mode = mode; }
      toggle.setAttribute('aria-label', state.status === 'ready' ? 'Read this page' : state.status === 'error' ? 'Retry' : playing || busy ? 'Pause' : 'Resume');
      toggle.classList.toggle('busy', busy); toggle.disabled = state.status === 'preparing' || state.status === 'analyzing';
      const miniToggle = el<HTMLButtonElement>('mini-toggle');
      miniToggle.innerHTML = icon(mode,18); miniToggle.disabled = toggle.disabled;
      miniToggle.setAttribute('aria-label', toggle.getAttribute('aria-label')!);
      miniToggle.classList.toggle('busy', busy);
      for (const id of ['back', 'forward', 'timeline']) (el(id) as HTMLButtonElement).disabled = !state.count;
      const timeline = el<HTMLInputElement>('timeline');
      if (!scrubbing) { timeline.max = String(Math.max(1, state.duration)); timeline.value = String(state.position); el('position').textContent = formatTime(state.position); }
      timeline.style.setProperty('--progress', `${state.duration ? state.position / state.duration * 100 : 0}%`);
      el('duration').textContent = `${state.estimated ? '~' : ''}${formatTime(state.duration)}`;
      el('duration').title = state.estimated ? 'Duration is updated as audio is generated. Seeking into unprepared audio is approximate.' : 'Exact duration';
      el<HTMLSelectElement>('speed').value = String(state.speed);
    }
    const onMessage: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (message, sender, reply) => {
      if (sender.id !== chrome.runtime.id) return;
      if (message.type === 'PING') { reply({ ok: true, title: document.title, url: location.href }); }
      else if (message.type === 'SHOW_PLAYER') {
        if(message.state.status==='ready'){expanded=false;expandedByUser=false;}
        revision++; preparing = true; minimized = message.state.status === 'ready'; collapsed = false; render(message.state); reply({ ok: true });
      } else if (message.type === 'HIDE_PLAYER') {
        revision++; preparing = false; render({ ...emptyState }); reply({ ok: true });
      } else if (message.type === 'EXTRACT_PAGE') {
        try { const page = extractPage(document, window.getSelection()?.toString() || ''); reply({ ok: true, page }); }
        catch (error) { reply({ ok: false, error: friendlyError(error) }); }
      } else if (message.type === 'PLAYER_STATE') { revision++; render(message.state); }
    };
    function initDock() {
      const initialRevision = revision;
      void chrome.runtime.sendMessage({ target: 'background', type: 'INIT_DOCK', title: document.title }).then(reply => { if (reply.ok && reply.state && revision === initialRevision) render(reply.state); }).catch(() => {});
    }
    // Leaving the document ends its reading; same-document navigations never fire pagehide.
    const onPageHide = () => { void chrome.runtime.sendMessage({ target: 'background', type: 'PAGE_HIDE' }).catch(() => {}); };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) { revision++; render({ ...emptyState, status: 'ready', title: document.title || 'This page', site: location.hostname }); initDock(); } };
    chrome.runtime.onMessage.addListener(onMessage);
    addEventListener('pagehide', onPageHide);
    addEventListener('pageshow', onPageShow);
    shared.__slushDispose = () => {
      chrome.runtime.onMessage.removeListener(onMessage);
      removeEventListener('pagehide', onPageHide);
      removeEventListener('pageshow', onPageShow);
      host?.remove(); host = undefined; shadow = undefined;
      shared.__slushReader = false; shared.__slushDispose = undefined;
    };
    render({ ...emptyState, status: 'ready', title: document.title || 'This page', site: location.hostname });
    initDock();
  },
});
