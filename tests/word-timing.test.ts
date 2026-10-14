import { describe,expect,it } from 'vitest';
import { alignWords,estimateWords,tokenize,wordAt } from '../lib/word-timing';
describe('Word timing',()=>{
  it('keeps original text offsets around punctuation and Russian words',()=>{
    const text='Привет, мир! Как дела?';
    const words=tokenize(text,'ru');
    expect(words.map(word=>word.text)).toEqual(['Привет','мир','Как','дела']);
    expect(words.every(word=>text.slice(word.from,word.to)===word.text)).toBe(true);
  });
  it('matches recognized words without replacing the original wording',()=>{
    const result=alignWords(tokenize('Hello, WORLD!','en'),[{word:'hello',start:.2,end:.6},{word:'world.',start:1,end:2}]);
    expect(result.timed).toBe(true);expect(result.words.map(word=>word.text)).toEqual(['Hello','WORLD']);
    expect(wordAt(result.words,.8)).toBe(-1);expect(wordAt(result.words,1.2)).toBe(1);
  });
  it('uses anchors to interpolate an omitted word',()=>{
    const result=alignWords(tokenize('one two three','en'),[{word:'one',start:0,end:1},{word:'three',start:2,end:3}]);
    expect(result.timed).toBe(true);expect(result.words[1].start).toBe(1);expect(result.words[1].end).toBeLessThanOrEqual(2);
  });
  it('falls back when recognition does not match the original text',()=>{
    expect(alignWords(tokenize('one two three','en'),[{word:'unrelated',start:0,end:1}]).timed).toBe(false);
    const words=estimateWords(tokenize('short longer','en'),10);expect(words[1].start).toBeGreaterThan(0);expect(words.at(-1)!.end).toBeLessThanOrEqual(10);
  });
});
