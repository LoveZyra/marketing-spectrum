/**
 * 「浏览器自己下」这条路上的响应头。
 *
 * 页面自己 `fetch` 再拼 blob 的时候,这些头**一个都不重要** —— `fetch` 根本不看
 * `Content-Disposition`,文件名是前端 `a.download` 自己写的。一旦改成让浏览器
 * 导航过去,它们就全变成了必需品,而且各自对应一个具体的坏结果:
 *
 * - **少了 `Content-Length`** → 走 chunked,浏览器只能显示"已下载 XX MB",
 *   **画不出百分比和剩余时间**。这是进度条唯一的硬前提。
 * - **`Content-Disposition` 少了 `filename`** → 浏览器拿 URL 末段当文件名,
 *   `/…/files/download?ticket=…` 存下来会叫 `download`。
 * - **只写 `filename="中文.txt"`** → 头里只能放 ASCII,中文名会变成乱码或被截断。
 *   必须再给一份 RFC 5987 的 `filename*=UTF-8''…`,现代浏览器优先认后者,
 *   老浏览器回落到前者。
 */

/**
 * 文件名里的换行会**把一个头劈成两个** —— 这是响应头注入。文件名来自用户能
 * 控制的路径,所以这里不是理论风险。控制字符一律换成下划线。
 */
const stripControl = (value) => value.replace(/[\u0000-\u001f\u007f]/g, '_');

/**
 * 拼一条带文件名的 `Content-Disposition: attachment`。
 *
 * 两份文件名都给:ASCII 回落版(去掉非 ASCII、引号和反斜杠)+ RFC 5987 的
 * UTF-8 版。回落版整个非 ASCII 都没了的话给个 `download`,总比空字符串强。
 */
/**
 * @param {string} fileName
 * @returns {string}
 */
export function attachmentDisposition(fileName) {
  const safe = stripControl(String(fileName || '')).replace(/[/\\]/g, '_').trim();
  const base = safe || 'download';

  // 去掉非 ASCII 之后再 trim:"季度报告 2026.xlsx" 的回落版否则会以空格开头。
  const ascii = base.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').trim() || 'download';
  const encoded = encodeURIComponent(base);

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * 给一次"浏览器直接下"的响应铺好头。
 *
 * `size` 传 `null` 表示**长度未知**(流式打包就是这种:边压边发,压完才知道多大)。
 * 这时不写 `Content-Length` —— 写一个猜的值比不写糟得多,浏览器会在到达这个
 * 数字时**提前把下载判成完成**,用户拿到一个截断的文件。
 *
 * @param {import('express').Response} res
 * @param {{ fileName: string, size?: number | null, mimeType?: string }} options
 */
export function setDownloadHeaders(res, { fileName, size = null, mimeType = 'application/octet-stream' }) {
  res.setHeader('Content-Type', mimeType);
  // 类型是我们自己声明的,别让浏览器再去嗅探出一个能执行的类型来。
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', attachmentDisposition(fileName));
  if (typeof size === 'number' && Number.isFinite(size) && size >= 0) {
    res.setHeader('Content-Length', String(size));
  }
}
