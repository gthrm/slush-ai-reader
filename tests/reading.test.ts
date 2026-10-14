import { describe, expect, it } from 'vitest';
import { extractBlocks, extractPage } from '../lib/extract';
import { buildChunks, locateTime, splitText } from '../lib/chunks';
import { defaults, type PageContent, type ReadingPlan } from '../lib/types';

const page: PageContent = { url: 'https://example.com', title: 'Заголовок', site: 'example.com', author: '', language: 'ru', extraction: 'readability', blocks: [
  { id: 0, kind: 'heading', text: 'Заголовок' }, { id: 1, kind: 'paragraph', text: 'Настоящий текст статьи со всеми подробностями.' }, { id: 2, kind: 'table', text: 'Стоимость | 100' }, { id: 3, kind: 'paragraph', text: 'Подпишитесь на рассылку.' },
] };
const plan: ReadingPlan = { title: 'Заголовок', pageType: 'article', language: 'ru', excludedBlockIds: [3], spokenBlocks: [{ id: 2, text: 'Стоимость составляет сто.' }] };
describe('Extraction', () => {
  it('preserves table columns, quote containers, lists and source order without duplicate nested text', () => {
    const root = document.createElement('div');
    root.innerHTML = '<h2>Раздел</h2><blockquote><p>Цитата</p></blockquote><ul><li><p>Пункт</p></li></ul><table><tr><th>План</th><th>Цена</th></tr><tr><td>Старт</td><td>100</td></tr></table><pre><code>let n = 1</code></pre>';
    expect(extractBlocks(root).map(b => b.text)).toEqual(['Раздел','Цитата','Пункт','План | Цена\nСтарт | 100','let n = 1']);
    expect(extractBlocks(root).map(b => b.kind)).toEqual(['heading','quote','list','table','code']);
  });
  it('reads selected text without including the rest of the document', () => {
    const doc = new DOMParser().parseFromString('<main>Не нужно читать.</main>', 'text/html');
    const selection = 'Это выделенный фрагмент, который пользователь хочет услышать.';
    expect(extractPage(doc, selection).blocks).toEqual([{id:0,kind:'paragraph',text:selection}]);
    expect(extractPage(doc, selection).extraction).toBe('selection');
  });
  it('skips discussion author headers while retaining the actual message text and inline quotations', () => {
    const root=document.createElement('div');
    root.innerHTML='<div class="comment-author"><p>Alice</p></div><p>Alice said hello in the actual story.</p><div class="comment-meta"><p>5 minutes ago · Reply</p></div><div class="comment-author"><p>Bob</p></div><p>The second message body.</p>';
    expect(extractBlocks(root).map(block=>block.text)).toEqual(['Alice said hello in the actual story.','The second message body.']);
  });
  it('rejects an oversized page instead of silently truncating it', () => {
    const doc = new DOMParser().parseFromString('<main>Текст</main>', 'text/html');
    expect(() => extractPage(doc, 'я'.repeat(80_001))).toThrow('too large');
  });
  it('removes forms and navigation from fallback extraction', () => {
    const doc = new DOMParser().parseFromString('<body><nav>МЕНЮ</nav><main><p>Значимый текст страницы, который нужно прочитать вслух целиком.</p><form><p>СЕКРЕТ</p><input value="password"></form></main></body>', 'text/html');
    const text = extractPage(doc).blocks.map(b => b.text).join(' ');
    expect(text).toContain('Значимый'); expect(text).not.toContain('СЕКРЕТ'); expect(text).not.toContain('МЕНЮ');
  });
});
describe('Narration and seeking', () => {
  it('keeps substantive prose, uses human-readable tables, excludes chrome and avoids duplicate title', () => {
    const text = buildChunks(page, plan).map(c => c.text).join(' ');
    expect(text.match(/Заголовок/g)).toHaveLength(1);
    expect(text).toContain(page.blocks[1].text); expect(text).toContain('Стоимость составляет сто.'); expect(text).not.toContain('Подпишитесь');
  });
  it('rejects fabricated block IDs', () => {
    expect(() => buildChunks(page, {...plan, excludedBlockIds:[100]})).toThrow('invalid page structure');
  });
  it('rejects a reading plan that excludes the entire body', () => {
    expect(() => buildChunks(page, {...plan, excludedBlockIds:[0,1,2,3]})).toThrow('no readable content');
  });
  it('splits large input without losing or reordering words', () => {
    const text = 'Первое предложение со смыслом. Второе предложение тоже важно. '.repeat(200);
    const pieces = splitText(text,1100,'ru');
    expect(pieces.every(p => p.length<=1100)).toBe(true);
    expect(pieces.join(' ').replace(/\s+/g,' ').trim()).toBe(text.trim());
  });
  it('keeps natural sentence boundaries when individual sentences fit the chunk budget', () => {
    const sentence='У этого предложения естественная точка остановки. ';
    const pieces=splitText(sentence.repeat(30),200,'ru');
    expect(pieces.every(piece=>piece.endsWith('.'))).toBe(true);
    expect(pieces.every(piece=>piece.length<=200)).toBe(true);
  });
  it('locates seeks across chunk boundaries and clamps beginning/end', () => {
    const chunk = buildChunks(page,plan)[0];
    const chunks = [{ ...chunk, duration: 10 }, { ...chunk, duration: 10 }];
    expect(locateTime(chunks,-15)).toEqual({index:0,offset:0});
    expect(locateTime(chunks,12)).toEqual({index:1,offset:2});
    expect(locateTime(chunks,1e6).index).toBe(chunks.length-1);
    expect(locateTime(chunks,1e6).offset).toBe(9.95);
  });
  it('does not invent an intro for selected text', () => {
    const selected = {...page,extraction:'selection' as const,blocks:[page.blocks[1]]};
    const chunks = buildChunks(selected,{...plan,excludedBlockIds:[],spokenBlocks:[]});
    expect(chunks.map(c=>c.text).join(' ')).toBe(page.blocks[1].text);
  });
  it('defaults to a real neural voice with normal playback speed', () => { expect(defaults.voice).toBe('marin'); expect(defaults.speed).toBe(1); });
  it('never reads generated introductions, even from an older saved plan', () => {
    const olderPlan = { ...plan, opening: 'Alice says. Bob says. This article was written by Carol.' };
    const text = buildChunks(page,olderPlan).map(chunk=>chunk.text).join(' ');
    expect(text).not.toContain('says'); expect(text).not.toContain('Carol');
    expect(text).toContain(page.blocks[1].text);
  });
  it('rejects model-authored speaker labels and rewrites of source prose', () => {
    const altered = {...plan,spokenBlocks:[{id:1,text:'Alice says: invented commentary.'},...plan.spokenBlocks]};
    const text = buildChunks(page,altered).map(chunk=>chunk.text).join(' ');
    expect(text).toContain(page.blocks[1].text); expect(text).not.toContain('Alice');
  });
});
