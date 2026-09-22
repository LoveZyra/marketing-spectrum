import { createLogger } from './logger.js';
const log = createLogger('attachments');

/**
 * 发给模型之前,把图片在**内存里**缩一遍。**磁盘上的原图一个字节都不动。**
 *
 * ## 为什么
 *
 * 用户贴什么就传什么:一张手机原图 2.7 MB,base64 之后 3.6 MB 字符,而且它躺在
 * transcript 里,**以后每一轮都会再发一次**。模型端反正也会把长边缩到 ~1568px
 * (Anthropic 的做法;OpenAI 系是 2048),多传的那些字节纯粹是浪费 —— 而在把 base64
 * 当文本计数的网关下,它们直接变成"Input exceeds the context limit (1048566 tokens)"。
 *
 * 缩到长边 1568、~1 MB 以内,单张能小一个数量级,**对识别几乎没影响**。
 *
 * ## 三条边界
 *
 * 1. **只动内存里的 buffer**,不写回文件。预览、图片查看器、文件树下载走的都是原图。
 * 2. **不换格式**:PNG 进 PNG 出,JPEG 进 JPEG 出。带文字的截图多是 PNG,转 JPEG 会把
 *    小字糊掉;所以 PNG 超限时先无损压,再退到 256 色调色板(文字仍然锐利),
 *    还超就认了,**不转 JPEG**。
 * 3. **缩不动就原样发**:sharp 不在、图坏了、动图(GIF 多帧)—— 一律退回原字节,
 *    只记一行 warn。这一步是优化,不是门,不能因为它把消息拦下来。
 *
 * ## 旋钮(都可选)
 *
 * - `PRISM_IMAGE_DOWNSCALE=0`  整个关掉
 * - `PRISM_IMAGE_MAX_EDGE`     长边像素,默认 1568,最小 256
 * - `PRISM_IMAGE_MAX_BYTES`    目标字节数,默认 1048576(1 MB)
 */

export const DEFAULT_MAX_EDGE = 1568;
export const DEFAULT_MAX_BYTES = 1024 * 1024;

const readIntEnv = (name: string, fallback: number, min: number): number => {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
};

export function downscaleSettings(): { enabled: boolean; maxEdge: number; maxBytes: number } {
  return {
    enabled: process.env.PRISM_IMAGE_DOWNSCALE !== '0',
    maxEdge: readIntEnv('PRISM_IMAGE_MAX_EDGE', DEFAULT_MAX_EDGE, 256),
    maxBytes: readIntEnv('PRISM_IMAGE_MAX_BYTES', DEFAULT_MAX_BYTES, 64 * 1024),
  };
}

export type DownscaleResult = {
  bytes: Buffer;
  /** 与输入一致 —— 这一步不换格式。 */
  mediaType: string;
  changed: boolean;
  /** 没缩的原因(没缩就有;缩了就没有)。 */
  reason?: 'disabled' | 'within-limits' | 'animated' | 'unsupported' | 'sharp-unavailable' | 'error';
  original: { bytes: number; width?: number; height?: number };
  output: { bytes: number; width?: number; height?: number };
};

type SharpModule = typeof import('sharp');
let sharpModule: Promise<SharpModule | null> | null = null;

/**
 * 懒加载 + 缓存。sharp 是原生模块,装不上的机器上服务照样要能起来 ——
 * 只在第一次真要缩图时才 import,失败了记一次、之后全部退回原图。
 */
async function loadSharp(): Promise<SharpModule | null> {
  if (!sharpModule) {
    sharpModule = import('sharp')
      .then((mod) => (mod.default ?? mod) as SharpModule)
      .catch((error: unknown) => {
        log.warn('[Images] sharp 不可用,发给模型的图片不再缩放:', error instanceof Error ? error.message : String(error));
        return null;
      });
  }
  return sharpModule;
}

/** 仅供测试:重置 sharp 加载缓存。 */
export function __resetDownscaleForTest(): void {
  sharpModule = null;
}

const RESIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function downscaleImageForModel(
  bytes: Buffer,
  mediaType: string,
  settings = downscaleSettings(),
): Promise<DownscaleResult> {
  const passthrough = (reason: DownscaleResult['reason'], dims?: { width?: number; height?: number }): DownscaleResult => ({
    bytes,
    mediaType,
    changed: false,
    reason,
    original: { bytes: bytes.length, ...dims },
    output: { bytes: bytes.length, ...dims },
  });

  if (!settings.enabled) return passthrough('disabled');
  // GIF 多半是动图,重编码会只剩第一帧;这里干脆不碰。
  if (!RESIZABLE.has(mediaType)) return passthrough('unsupported');

  const sharp = await loadSharp();
  if (!sharp) return passthrough('sharp-unavailable');

  try {
    const meta = await sharp(bytes, { failOn: 'none' }).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    const dims = { width, height };
    if ((meta.pages ?? 1) > 1) return passthrough('animated', dims);

    /**
     * EXIF 方向标签:手机竖拍的图,像素其实是横的、靠标签转正。`rotate()` 不带参数
     * = 按标签把像素真的转过来再把标签去掉 —— 否则缩完的图在不认标签的模型那里
     * 是躺着的。长边与朝向无关,直接取 max。
     */
    const withinEdge = Math.max(width, height) <= settings.maxEdge;
    const needsOrient = (meta.orientation ?? 1) !== 1;
    if (withinEdge && bytes.length <= settings.maxBytes && !needsOrient) {
      // 尺寸和体积都在线内、也不用转正:一个字节都不改,连重编码都省了。
      return passthrough('within-limits', dims);
    }

    const base = () => sharp(bytes, { failOn: 'none' })
      .rotate()
      .resize({ width: settings.maxEdge, height: settings.maxEdge, fit: 'inside', withoutEnlargement: true });

    let out: Buffer;
    if (mediaType === 'image/jpeg') {
      out = await base().jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    } else if (mediaType === 'image/webp') {
      out = await base().webp({ quality: 85 }).toBuffer();
    } else {
      // PNG:先无损;还超就退到调色板(256 色,文字依旧锐利);再超就认了,不转 JPEG。
      out = await base().png({ compressionLevel: 9 }).toBuffer();
      if (out.length > settings.maxBytes) {
        const quantized = await base().png({ compressionLevel: 9, palette: true }).toBuffer();
        if (quantized.length < out.length) out = quantized;
      }
    }

    // 缩完反而更大(小图 + 高压缩率原文件会这样)—— 那就用原来的。
    if (out.length >= bytes.length && withinEdge && !needsOrient) {
      return passthrough('within-limits', dims);
    }

    const outMeta = await sharp(out).metadata();
    return {
      bytes: out,
      mediaType,
      changed: true,
      original: { bytes: bytes.length, ...dims },
      output: { bytes: out.length, width: outMeta.width, height: outMeta.height },
    };
  } catch (error) {
    log.warn('[Images] 缩图失败,按原图发送:', error instanceof Error ? error.message : String(error));
    return passthrough('error');
  }
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}
