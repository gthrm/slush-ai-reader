import type { SpeechWord, TranscriptWord } from './types';

export function tokenize(text: string, language = 'ru'): TranscriptWord[] {
  let segmenter: Intl.Segmenter;
  try { segmenter = new Intl.Segmenter(language, { granularity: 'word' }); }
  catch { segmenter = new Intl.Segmenter('ru', { granularity: 'word' }); }
  return Array.from(segmenter.segment(text)).filter(part => part.isWordLike).map(part => ({ text: part.segment, from: part.index, to: part.index + part.segment.length, start: 0, end: 0 }));
}
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, '');

export function estimateWords(words: TranscriptWord[], duration: number): TranscriptWord[] {
  const weights = words.map(word => Math.max(2, word.text.length));
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  let position = 0;
  return words.map((word, index) => {
    const span = weights[index] / total * duration;
    const result = { ...word, start: position, end: position + span * 0.94 };
    position += span; return result;
  });
}

export function alignWords(source: TranscriptWord[], recognized: SpeechWord[]): { words: TranscriptWord[]; timed: boolean } {
  const speech = recognized.filter(word => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
  if (!source.length || !speech.length) return { words: source, timed: false };
  const a = source.map(word => normalize(word.text));
  const b = speech.map(word => normalize(word.word));
  // Monotonic alignment keeps the displayed original words, even if ASR has omissions.
  const width = b.length + 1;
  const scores = new Uint16Array((a.length + 1) * width);
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    scores[i * width + j] = a[i - 1] === b[j - 1] ? scores[(i - 1) * width + j - 1] + 1 : Math.max(scores[(i - 1) * width + j], scores[i * width + j - 1]);
  }
  const matches = new Map<number, SpeechWord>();
  let i = a.length, j = b.length;
  while (i && j) {
    if (a[i - 1] === b[j - 1]) { matches.set(i - 1, speech[j - 1]); i--; j--; }
    else if (scores[(i - 1) * width + j] >= scores[i * width + j - 1]) i--;
    else j--;
  }
  if (matches.size / source.length < 0.6) return { words: source, timed: false };
  const words = source.map((word, index) => {
    const match = matches.get(index);
    return match ? { ...word, start: match.start, end: match.end } : { ...word, start: -1, end: -1 };
  });
  for (let first = 0; first < words.length;) {
    if (words[first].start >= 0) { first++; continue; }
    let last = first;
    while (last < words.length && words[last].start < 0) last++;
    const start = first ? words[first - 1].end : 0;
    const end = last < words.length ? words[last].start : speech.at(-1)!.end;
    const filled = estimateWords(words.slice(first, last), Math.max(0, end - start));
    for (let k = first; k < last; k++) words[k] = { ...filled[k - first], start: start + filled[k - first].start, end: start + filled[k - first].end };
    first = last;
  }
  return { words, timed: true };
}

export function wordAt(words: TranscriptWord[], time: number): number {
  let low = 0, high = words.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (time < words[middle].start) high = middle - 1;
    else if (time >= words[middle].end) low = middle + 1;
    else return middle;
  }
  return -1;
}
