import {describe,expect,it} from 'vitest';
import {defaults,readStoredSettings,voices} from '../lib/types';
describe('Curated voices',()=>{
  it('exposes exactly Marin, Cedar and Coral',()=>{expect(voices).toEqual(['marin','cedar','coral']);});
  it('migrates a removed voice without losing the API key or other preferences',()=>{
    const stored={...defaults,apiKey:'sk-test-secret',voice:'ash',speed:1.5,style:'calm',instructions:'Gentle pauses',highlightWords:false};
    expect(readStoredSettings(stored)).toEqual({...stored,voice:'marin'});
  });
  it('keeps the API key when another stored field is invalid',()=>{
    const stored={...defaults,apiKey:'sk-test-secret',voice:'cedar',speed:5,style:'loud',instructions:'x'.repeat(700)};
    expect(readStoredSettings(stored)).toEqual({...defaults,apiKey:'sk-test-secret',voice:'cedar'});
  });
  it('preserves a supported voice',()=>{expect(readStoredSettings({...defaults,voice:'cedar'}).voice).toBe('cedar');});
});
