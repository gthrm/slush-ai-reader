import { beforeEach,describe,expect,it,vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { preparedKey,PreparedCache } from '../lib/prepared-cache';
import type { PageContent } from '../lib/types';
const page:PageContent={url:'https://example.com/article#part',title:'Title',author:'',site:'example.com',language:'en',extraction:'readability',blocks:[{id:0,kind:'paragraph',text:'The original article text.'}]};
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));
describe('Prepared text cache',()=>{
  it('invalidates when article content changes but ignores URL fragments',async()=>{
    expect(await preparedKey(page)).toBe(await preparedKey({...page,url:'https://example.com/article#other'}));
    expect(await preparedKey(page)).not.toBe(await preparedKey({...page,blocks:[{...page.blocks[0],text:'Updated article text.'}]}));
  });
  it('returns a copy of the cached plan',async()=>{
    const cache=new PreparedCache();const key=await preparedKey(page);
    await cache.set(key,{plan:{title:'Title',pageType:'article',language:'en',excludedBlockIds:[],spokenBlocks:[{id:0,text:'Original'}]},savedAt:Date.now()});
    const first=(await cache.get(key))!;first.plan.spokenBlocks[0].text='Changed';
    expect((await cache.get(key))!.plan.spokenBlocks[0].text).toBe('Original');cache.clearMemory();expect(await cache.get(key)).toBeUndefined();
  });
});
