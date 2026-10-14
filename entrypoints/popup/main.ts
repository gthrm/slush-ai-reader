import { icon } from '../../lib/icons';
import { clientFor, synthesize } from '../../lib/api';
import { defaults, friendlyError, settingsSchema, voices, type PlayerState, type Reply, type Settings } from '../../lib/types';
import './style.css';

document.querySelector('#app')!.innerHTML = `
  <header><div class="identity"><span class="brand-icon">${icon('audio', 20)}</span><span class="logo">slush<span class="logo-dot">.</span></span></div><span class="header-note">SETTINGS</span></header>
  <main>
    <div id="site-access" class="site-access" hidden><p>Automatic display needs access to websites.</p><button id="allow-sites" type="button">Enable automatic panel on all sites</button></div>
    <form id="settings-form">
      <div class="field-row"><label for="voice">Voice</label><button type="button" id="preview" class="text-button">${icon('volume',14)} Preview</button></div>
      <select id="voice">${voices.map(voice => `<option value="${voice}">${voice[0].toUpperCase() + voice.slice(1)}</option>`).join('')}</select>
      <fieldset><legend>Reading style</legend><div class="segmented"><label><input name="style" type="radio" value="natural" checked><span>Natural</span></label><label><input name="style" type="radio" value="calm"><span>Calm</span></label><label><input name="style" type="radio" value="expressive"><span>Expressive</span></label></div></fieldset>
      <div class="field-row speed-label"><label for="speed">Speed</label><output id="speed-output" for="speed">1×</output></div><input id="speed" class="speed-range" type="range" min="0.75" max="2" step="0.25" value="1"><div class="range-labels"><span>Unhurried</span><span>A little faster</span></div>
      <details class="custom"><summary>Custom voice instructions ${icon('down',14)}</summary><label class="sr-only" for="instructions">Voice instructions</label><textarea id="instructions" maxlength="600" placeholder="For example: leave slightly longer pauses between paragraphs" rows="2"></textarea></details>
      <label class="highlight-setting"><input id="highlight-words" type="checkbox" checked><span>Highlight words in the player<small>Audio timing uses additional transcription requests.</small></span></label>
      <div id="key-section" class="key-section"><div class="field-row"><label for="api-key">${icon('key',14)} OpenAI API key</label><a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">Get a key ${icon('arrow',12)}</a></div><p id="key-help" class="key-help" hidden>Paste your key here and save it to start reading.</p><div class="key-input"><input id="api-key" type="password" placeholder="sk-…" aria-describedby="key-help" autocomplete="off" spellcheck="false"><button type="button" id="show-key" aria-label="Show API key">${icon('eye',17)}</button></div><p class="privacy">Your key stays on this device. Page text is sent<br>to OpenAI only when you start reading.</p></div>
      <button type="submit" id="save" class="save-button">Save settings ${icon('check',15)}</button>
    </form>
    <div id="notice" class="notice" role="status" aria-live="polite" hidden></div>
  </main><footer><span>${icon('sparkles',12)} AI-generated voice</span><button id="clear-text-cache" type="button">Clear text</button><button id="clear-audio-cache" type="button">Clear audio</button></footer>`;

function el<T extends HTMLElement = HTMLElement>(id: string) { return document.getElementById(id) as T; }
let saved: Settings = { ...defaults };
let state: PlayerState | undefined;
let previewAudio: HTMLAudioElement | undefined;
let previewUrl: string | undefined;
let previewController: AbortController | undefined;
let tabId: number | undefined;
let saving = false;
let resumeAfterSetup = false;
let preferenceTimer: ReturnType<typeof setTimeout> | undefined;
let preferencesSaving = false;
let preferencesQueued = false;
// Typed voice instructions wait for blur or popup close: each save re-synthesizes the current passage.
let instructionsDirty = false;
let settingsWrites: Promise<void> = Promise.resolve();

async function request(type: string, extra: object = {}): Promise<Reply> {
  if (!globalThis.chrome?.runtime?.id) throw new Error('Load the extension folder in Chrome to start reading.');
  const reply = await chrome.runtime.sendMessage({ target: 'background', type, ...extra });
  if (!reply?.ok) throw new Error(reply?.error || 'The extension did not respond. Reload it and try again.');
  return reply;
}
function notice(text: string, error = false) {
  el('notice').hidden = false; el('notice').textContent = text; el('notice').classList.toggle('error', error);
}
function readSettings(): Settings {
  return settingsSchema.parse({
    apiKey: el<HTMLInputElement>('api-key').value.trim(), voice: el<HTMLSelectElement>('voice').value,
    speed: Number(el<HTMLInputElement>('speed').value),
    style: (document.querySelector('input[name="style"]:checked') as HTMLInputElement).value,
    instructions: el<HTMLTextAreaElement>('instructions').value.trim(),
    highlightWords: el<HTMLInputElement>('highlight-words').checked,
  });
}
function fillSettings(settings: Settings) {
  saved = settings; el<HTMLInputElement>('api-key').value = settings.apiKey;
  el<HTMLSelectElement>('voice').value = settings.voice; el<HTMLInputElement>('speed').value = String(settings.speed);
  el('speed-output').textContent = `${settings.speed}×`;
  (document.querySelector(`input[name="style"][value="${settings.style}"]`) as HTMLInputElement).checked = true;
  el<HTMLTextAreaElement>('instructions').value = settings.instructions;
  el<HTMLInputElement>('highlight-words').checked = settings.highlightWords;
}
async function save(includeKey = true) {
  const next = readSettings();
  const write = settingsWrites.then(async()=>{
    if(!includeKey)next.apiKey=saved.apiKey;
    await request('SAVE_SETTINGS', { settings: next }); saved = next;
  });
  settingsWrites=write.catch(()=>{});await write;
}
async function savePreferences() {
  if(preferencesSaving){preferencesQueued=true;return;}
  preferencesSaving=true;instructionsDirty=false;
  try { await save(false); notice('Saved. Changes apply to the current reading.'); }
  catch(error){notice(friendlyError(error),true);}
  finally{preferencesSaving=false;if(preferencesQueued){preferencesQueued=false;void savePreferences();}}
}
function schedulePreferences(delay=180) {
  if(preferenceTimer)clearTimeout(preferenceTimer);
  preferenceTimer=setTimeout(()=>{preferenceTimer=undefined;void savePreferences();},delay);
}
el('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); if (saving) return; saving = true;
  el<HTMLButtonElement>('save').disabled = true;
  if(preferenceTimer)clearTimeout(preferenceTimer);preferenceTimer=undefined;instructionsDirty=false;
  try { await save(); if (resumeAfterSetup && readSettings().apiKey) { resumeAfterSetup = false; await request('START_TAB', { tabId }); window.close(); return; } notice('Settings saved. Changes apply to the current reading.'); }
  catch (error) { notice(friendlyError(error), true); }
  finally { saving = false; el<HTMLButtonElement>('save').disabled = false; }
});
el('speed').addEventListener('input', () => { el('speed-output').textContent = `${el<HTMLInputElement>('speed').value}×`;schedulePreferences(); });
el('voice').addEventListener('change',()=>{stopPreview();schedulePreferences(0);});
document.querySelectorAll('input[name="style"]').forEach(input=>input.addEventListener('change',()=>{stopPreview();schedulePreferences(0);}));
el('instructions').addEventListener('input',()=>{instructionsDirty=true;});
el('instructions').addEventListener('change',()=>{if(instructionsDirty)schedulePreferences(0);});
el('highlight-words').addEventListener('change',()=>schedulePreferences(0));
el('clear-text-cache').addEventListener('click',()=>{void request('CLEAR_PREPARED').then(()=>notice('Cached text cleared.')).catch(error=>notice(friendlyError(error),true));});
el('clear-audio-cache').addEventListener('click',()=>{void request('CLEAR_AUDIO').then(()=>notice('Cached audio cleared.')).catch(error=>notice(friendlyError(error),true));});
el('show-key').addEventListener('click', () => {
  const input = el<HTMLInputElement>('api-key'); const show = input.type === 'password';
  input.type = show ? 'text' : 'password'; el('show-key').innerHTML = icon(show ? 'hidden' : 'eye',17);
  el('show-key').setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
});
el('allow-sites').addEventListener('click', async () => {
  try {
    const allowed = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
    if (allowed) { await request('ATTACH_OPEN_TABS'); el('site-access').hidden = true; }
    else notice('To show the panel automatically, allow Slush access on all sites in Chrome extension settings.', true);
  } catch (error) { notice(friendlyError(error), true); }
});
function stopPreview() {
  previewController?.abort(); previewController = undefined; previewAudio?.pause(); previewAudio = undefined;
  if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = undefined;
  el<HTMLButtonElement>('preview').disabled = false; el('preview').innerHTML = `${icon('volume',14)} Preview`;
}
el('preview').addEventListener('click', async () => {
  if (previewAudio) { stopPreview(); return; }
  stopPreview(); const controller = new AbortController(); previewController = controller;
  el<HTMLButtonElement>('preview').disabled = true; el('preview').innerHTML = `${icon('loading',14)} Preparing…`;
  try {
    const settings = readSettings();
    if (state && ['preparing','analyzing','playing','buffering'].includes(state.status)) throw new Error('Pause reading before previewing another voice.');
    const blob = await synthesize(clientFor(settings), 'Sometimes you just want to close your eyes and listen. Good writing deserves a little time. Shall we begin?', settings, 'en', controller.signal);
    if (controller.signal.aborted) return;
    previewUrl = URL.createObjectURL(blob); previewAudio = new Audio(previewUrl); previewAudio.playbackRate = settings.speed;
    previewAudio.addEventListener('ended', stopPreview, { once: true });
    await previewAudio.play(); el<HTMLButtonElement>('preview').disabled = false; el('preview').innerHTML = `${icon('pause',14)} Stop`;
  } catch (error) { if (!controller.signal.aborted) notice(friendlyError(error), true); stopPreview(); }
});
window.addEventListener('pagehide', ()=>{stopPreview();if(preferenceTimer||instructionsDirty){if(preferenceTimer)clearTimeout(preferenceTimer);preferenceTimer=undefined;instructionsDirty=false;if(!saving){const next=readSettings();next.apiKey=saved.apiKey;void request('SAVE_SETTINGS',{settings:next}).catch(()=>{});}}});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && message.target === 'popup' && message.type === 'CLOSE') window.close();
});

async function refresh() {
  const reply = await request('GET_STATE', { tabId }); state = reply.state;
}
const formControls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('form input,form select,form textarea,form button'));
formControls.forEach(control => { control.disabled = true; });
void (async () => {
  const reply = await request('GET_SETTINGS');
  fillSettings(reply.settings || defaults);
  el('site-access').hidden = await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
  resumeAfterSetup = Boolean(reply.focusApiKey);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = reply.tabId ?? tab?.id;
  const opening = request('OPEN_TAB', { tabId }).catch(error => notice(friendlyError(error), true));
  await opening;
  await refresh();
})().catch(error => { fillSettings(defaults); notice(friendlyError(error), true); }).finally(() => {
  formControls.forEach(control => { control.disabled = false; });
  document.body.dataset.ready = 'true';
  if (resumeAfterSetup) {
    el('key-help').hidden = false; el('key-section').classList.add('needs-key');
    el<HTMLInputElement>('api-key').focus();
  }
});
setInterval(() => { if (globalThis.chrome?.runtime?.id) void refresh().catch(() => {}); }, 1200);
