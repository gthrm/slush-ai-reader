import { ReadingEngine } from '../../lib/engine';
import type { Control, PageContent, Settings } from '../../lib/types';

const engine = new ReadingEngine(state => {
  void chrome.runtime.sendMessage({ target: 'background', type: 'STATE', state }).catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.tab || message?.target !== 'offscreen') return;
  if (message.type === 'START') {
    void engine.start(message.page as PageContent, message.settings as Settings, message.tabId);
    reply({ ok: true });
  } else if (message.type === 'CONTROL') {
    void engine.control(message.control as Control);
    reply({ ok: true });
  } else if (message.type === 'UPDATE_SETTINGS') {
    void engine.applySettings(message.settings as Settings);
    reply({ ok: true });
  } else if (message.type === 'CLEAR_PREPARED') {
    engine.clearPreparedCache(); reply({ ok: true });
  } else if (message.type === 'CLEAR_AUDIO') {
    void engine.clearAudioCache().then(()=>reply({ok:true})).catch(()=>reply({ok:false,error:'Unable to clear cached audio.'}));
    return true;
  } else if (message.type === 'GET_STATE') reply({ ok: true, state: engine.snapshot() });
});
