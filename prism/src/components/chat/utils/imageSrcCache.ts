/**
 * ee:聊天图片的 object URL 缓存(按 项目 + 路径)。
 *
 * 用户实测:发图后气泡里先出现图片,**突然变成一块紫底,过一会儿又显示图片**。
 * 三段分别是:乐观行(`local_*`)挂载 → 取 blob → 显示;回合结束历史刷新,服务端
 * 拷贝把乐观行**换掉**(id 不同 → React key 不同 → 图片组件卸载重挂,旧 object URL
 * 被 revoke)→ 新实例 `src` 从 null 起步,先画占位块(bg-muted,淡色主题下偏紫)→
 * 再取一遍同一个 blob → 才又显示。这正是 dg 定下的 I1(消息生命周期内 DOM 身份
 * 不变)在"带图的用户行"上的破口。
 *
 * 根治要么让服务端拷贝沿用乐观行的 id(牵动 store 去重的整套判定),要么让第二次
 * 挂载**零成本**:同一张图的 object URL 在模块级缓存里,重挂时同步拿到,不画占位、
 * 不重取。后者改动小、且顺带让"切会话再切回来"也不重取。
 *
 * 缓存有上限(条数 + 字节),LRU 淘汰;**正在被某个已挂载组件显示的条目不淘汰**
 * (refcount),否则淘汰即 revoke,屏幕上那张图会变成裂图。revoke 通过参数注入,
 * node 环境下的单测不依赖 URL.revokeObjectURL。
 */
export type ImageSrcCacheOptions = {
  maxEntries?: number;
  maxBytes?: number;
  revoke?: (url: string) => void;
};

type Entry = { url: string; bytes: number; refs: number };

export class ImageSrcCache {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly revoke: (url: string) => void;

  constructor(options: ImageSrcCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 40;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.revoke = options.revoke ?? ((url) => {
      if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    });
  }

  static key(projectId: string | null | undefined, imagePath: string): string {
    return `${projectId ?? ''}::${imagePath}`;
  }

  /** 命中即刷新 LRU 位置;不改 refcount(要显示请配合 acquire)。 */
  peek(key: string): string | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.url;
  }

  /** 组件开始显示这个 URL:计一个引用,淘汰时跳过。 */
  acquire(key: string): string | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    hit.refs += 1;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.url;
  }

  release(key: string): void {
    const hit = this.entries.get(key);
    if (hit && hit.refs > 0) hit.refs -= 1;
  }

  /** 放入一个新 URL(调用方随即视为已 acquire)。已有同 key 时保留旧的、revoke 新的。 */
  put(key: string, url: string, bytes: number): string {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.url !== url) this.revoke(url);
      existing.refs += 1;
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.url;
    }
    this.entries.set(key, { url, bytes: Math.max(0, bytes), refs: 1 });
    this.totalBytes += Math.max(0, bytes);
    this.evict();
    return url;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) return;
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) break;
      if (entry.refs > 0) continue;
      this.entries.delete(key);
      this.totalBytes -= entry.bytes;
      this.revoke(entry.url);
    }
  }
}

export const chatImageSrcCache = new ImageSrcCache();
