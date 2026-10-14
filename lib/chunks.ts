import type { Chunk, PageContent, ReadingPlan } from './types';

export function splitText(text: string, max = 1100, language = 'ru'): string[] {
  const sentences = Array.from(new Intl.Segmenter(language || 'ru', { granularity: 'sentence' }).segment(text), item => item.segment);
  const pieces: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length <= max) {
      if (current.length + sentence.length > max && current.trim()) { pieces.push(current.trim()); current = ''; }
      current += sentence;
      continue;
    }
    if (current.trim()) { pieces.push(current.trim()); current = ''; }
    // Word boundaries for unusually long sentences; hard split only single huge tokens.
    const words = sentence.match(/\S+\s*/g) || [];
    for (const word of words) {
      if (current.length + word.length > max && current.trim()) { pieces.push(current.trim()); current = ''; }
      if (word.length > max) {
        for (let i = 0; i < word.length; i += max) pieces.push(word.slice(i, i + max).trim());
      } else current += word;
    }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces.filter(Boolean);
}

export function buildChunks(page: PageContent, plan: ReadingPlan): Chunk[] {
  const ids = new Set(page.blocks.map(block => block.id));
  if (plan.excludedBlockIds.some(id => !ids.has(id)) || plan.spokenBlocks.some(block => !ids.has(block.id))) throw new Error('The model returned an invalid page structure. Try reading again.');
  const excluded = new Set(plan.excludedBlockIds);
  const adaptable = new Set(page.blocks.filter(block => block.kind === 'code' || block.kind === 'table').map(block => block.id));
  const replacements = new Map(plan.spokenBlocks.filter(block => adaptable.has(block.id)).map(block => [block.id, block.text]));
  let language = plan.language;
  try { new Intl.Segmenter(language); } catch { language = 'ru'; }
  let section = plan.title;
  const chunks: Chunk[] = [];
  const push = (text: string, blockId: number) => {
    for (const piece of splitText(text, 1100, language)) {
      chunks.push({ text: piece, section, blockId, duration: Math.max(1.5, piece.length / 14), exact: false });
    }
  };
  for (const block of page.blocks) {
    if (excluded.has(block.id)) continue;
    if (block.kind === 'heading') section = block.text;
    push(replacements.get(block.id) || block.text, block.id);
  }
  if (!chunks.some(chunk => chunk.blockId >= 0)) throw new Error('There is no readable content left. Try selecting a passage.');
  // Merge neighbouring small blocks to avoid one API request per short paragraph.
  const merged: Chunk[] = [];
  for (const chunk of chunks) {
    const prev = merged.at(-1);
    if (prev && prev.section === chunk.section && prev.text.length + chunk.text.length < 900) {
      prev.text += '\n\n' + chunk.text; prev.duration += chunk.duration;
    } else merged.push({ ...chunk });
  }
  return merged;
}

export function locateTime(chunks: Chunk[], seconds: number): { index: number; offset: number } {
  let remaining = Math.max(0, seconds);
  for (let index = 0; index < chunks.length; index++) {
    if (remaining < chunks[index].duration || index === chunks.length - 1) return { index, offset: Math.min(remaining, Math.max(0, chunks[index].duration - 0.05)) };
    remaining -= chunks[index].duration;
  }
  return { index: 0, offset: 0 };
}
