import { Readability } from '@mozilla/readability';
import type { Block, PageContent } from './types';

export function extractBlocks(root: ParentNode): Block[] {
  const selector = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table,figcaption';
  const blocks: Block[] = [];
  const metadata = '[rel="author"],[itemprop="author"],.byline,.comment-author,.comment-meta,.user-details,[data-testid="author"]';
  for (const node of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
    if (node.closest(metadata)) continue;
    // Keep container blocks intact: a table, quote or list item is one spoken unit.
    if (node.parentElement?.closest('li,blockquote,pre,table,figcaption')) continue;
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const tag = node.tagName.toLowerCase();
    const kind = /^h\d$/.test(tag) ? 'heading' : tag === 'li' ? 'list' : tag === 'blockquote' ? 'quote' : tag === 'pre' ? 'code' : tag === 'table' ? 'table' : tag === 'figcaption' ? 'caption' : 'paragraph';
    const readableText = kind === 'table'
      ? Array.from(node.querySelectorAll('tr')).map(row => Array.from(row.querySelectorAll('th,td')).map(cell => cell.textContent?.trim()).join(' | ')).join('\n')
      : text;
    blocks.push({ id: blocks.length, kind, text: readableText });
  }
  if (!blocks.length && !root.querySelector(selector)) {
    const text = (root.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) blocks.push({ id: 0, kind: 'paragraph', text });
  }
  return blocks;
}

export function extractPage(doc: Document, selectedText = ''): PageContent {
  const base = { url: doc.location?.href || '', title: doc.title, author: '', site: doc.location?.hostname || '', language: doc.documentElement.lang || '' };
  let result: PageContent;
  if (selectedText.trim()) {
    result = { ...base, blocks: [{ id: 0, kind: 'paragraph', text: selectedText.trim() }], extraction: 'selection' };
  } else {
    const clone = doc.cloneNode(true) as Document;
    clone.querySelectorAll('script,style,noscript,iframe,form,input,textarea,select,[hidden],[aria-hidden="true"],#slush-reader-host').forEach(node => node.remove());
    const parsed = new Readability(clone.cloneNode(true) as Document).parse();
    if (parsed?.content && (parsed.textContent?.length || 0) > 200) {
      // Parse into an inert document: no image loads or inline handlers in the page, and never into the player.
      const root = new DOMParser().parseFromString(parsed.content, 'text/html').body;
      result = { ...base, title: parsed.title || base.title, author: parsed.byline || '', site: parsed.siteName || base.site, blocks: extractBlocks(root), extraction: 'readability' };
    } else {
      const root = clone.querySelector('main,[role="main"],article') || clone.body;
      root.querySelectorAll('nav,footer,aside,[role="navigation"],button').forEach(node => node.remove());
      result = { ...base, blocks: extractBlocks(root), extraction: 'main' };
    }
  }
  const length = result.blocks.reduce((sum, block) => sum + block.text.length, 0);
  if (length < 30) throw new Error('There is too little text to read. Try selecting a passage.');
  if (length > 80_000 || result.blocks.length > 1200) throw new Error('This page is too large for the MVP. Select a passage and start reading.');
  return result;
}
