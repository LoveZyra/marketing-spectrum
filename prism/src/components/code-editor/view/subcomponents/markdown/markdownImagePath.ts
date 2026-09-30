/**
 * hl(P3 文件组):markdown 预览里的相对图片。
 *
 * 原来 `![](./chart.png)` 直接交给 `<img src>`,浏览器按**站点根**解析成
 * `/chart.png` —— 404,一张裂图。正确的基准是**这份 markdown 所在的目录**(相对项目根)。
 * 解析出项目内路径之后不能直接当 src:文件接口要登录态,`<img>` 带不上 Authorization 头,
 * 所以走 authenticatedFetch → blob URL(与图片查看器同一条路)。
 *
 * - `./a.png`、`../b.png`、`a.png`:相对 markdown 所在目录;
 * - `/a.png`:按仓库惯例当作相对项目根(按站点根解析只会得到 404);
 * - `http(s):`、`data:`、`blob:`:原样。
 */
export function resolveMarkdownImagePath(src: string, mdRelPath: string): string | null {
  if (!src || /^(https?:|data:|blob:|\/\/)/i.test(src)) return null;
  const cleaned = src.split('#')[0].split('?')[0];
  let decoded = cleaned;
  try { decoded = decodeURIComponent(cleaned); } catch { /* 保留原样 */ }
  const dirSegments = mdRelPath.replace(/\\/g, '/').split('/').slice(0, -1);
  const segments = decoded.startsWith('/') ? [] : [...dirSegments];
  for (const part of decoded.replace(/^\//, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) return null; // 跑到项目根之外:接口不会放行,别发请求
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join('/');
}
