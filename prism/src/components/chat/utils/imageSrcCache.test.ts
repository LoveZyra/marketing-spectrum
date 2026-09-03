import { describe, expect, it } from 'vitest';

import { ImageSrcCache } from './imageSrcCache';

/**
 * ee:聊天图片 object URL 缓存。乐观行被服务端拷贝换掉时图片组件重挂 ——
 * 第二次挂载必须同步命中缓存(不画占位、不重取),而正在显示的条目不能被淘汰。
 */
describe('ImageSrcCache', () => {
  it('put 之后 peek / acquire 命中同一个 URL;key 含项目 id', () => {
    const cache = new ImageSrcCache({ revoke: () => undefined });
    const key = ImageSrcCache.key('proj-1', '/p/attachments/a.png');
    expect(key).toBe('proj-1::/p/attachments/a.png');
    expect(cache.peek(key)).toBeNull();
    cache.put(key, 'blob:one', 1000);
    expect(cache.peek(key)).toBe('blob:one');
    expect(cache.acquire(key)).toBe('blob:one');
  });

  it('同 key 重复 put:保留旧 URL、revoke 新的(两个组件同时取到时不留孤儿)', () => {
    const revoked: string[] = [];
    const cache = new ImageSrcCache({ revoke: (url) => revoked.push(url) });
    const key = 'p::/a.png';
    expect(cache.put(key, 'blob:first', 10)).toBe('blob:first');
    expect(cache.put(key, 'blob:second', 10)).toBe('blob:first');
    expect(revoked).toEqual(['blob:second']);
    expect(cache.size).toBe(1);
  });

  it('LRU 淘汰只碰没人引用的条目;正在显示的(refs>0)跳过', () => {
    const revoked: string[] = [];
    const cache = new ImageSrcCache({ maxEntries: 2, revoke: (url) => revoked.push(url) });
    cache.put('a', 'blob:a', 1);            // refs 1(put 即持有)
    cache.put('b', 'blob:b', 1);
    cache.release('b');                     // b 没人看了
    cache.put('c', 'blob:c', 1);            // 超 2 条 → 淘汰最旧且无引用的:a 有引用跳过,b 被淘汰
    expect(revoked).toEqual(['blob:b']);
    expect(cache.peek('a')).toBe('blob:a');
    expect(cache.peek('b')).toBeNull();
    expect(cache.peek('c')).toBe('blob:c');
  });

  it('按字节上限淘汰,字节计数随淘汰回落', () => {
    const revoked: string[] = [];
    const cache = new ImageSrcCache({ maxBytes: 100, revoke: (url) => revoked.push(url) });
    cache.put('a', 'blob:a', 60); cache.release('a');
    cache.put('b', 'blob:b', 60); cache.release('b');   // 120 > 100 → 淘汰 a
    expect(revoked).toEqual(['blob:a']);
    expect(cache.bytes).toBe(60);
    expect(cache.size).toBe(1);
  });

  it('全部条目都在被引用时,超限也不淘汰(宁可多占内存,不出裂图)', () => {
    const revoked: string[] = [];
    const cache = new ImageSrcCache({ maxEntries: 1, revoke: (url) => revoked.push(url) });
    cache.put('a', 'blob:a', 1);
    cache.put('b', 'blob:b', 1);
    expect(revoked).toEqual([]);
    expect(cache.size).toBe(2);
  });

  it('release 不会把引用数减成负数', () => {
    const cache = new ImageSrcCache({ revoke: () => undefined });
    cache.put('a', 'blob:a', 1);
    cache.release('a'); cache.release('a'); cache.release('a');
    cache.put('b', 'blob:b', 1);
    // maxEntries 默认 40,不会淘汰;只验证不抛、状态一致
    expect(cache.size).toBe(2);
  });
});
