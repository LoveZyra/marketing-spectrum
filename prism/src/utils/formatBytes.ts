/**
 * 字节数的唯一展示口径:前端所有地方都用这一份,别再各写一个 formatBytes / formatFileSize
 * (各写一份就会漂:小数位、`< 1KB` 分支、GB 档各不相同,同一个面板上并排时肉眼可见)。
 *
 * 与服务端 `server/shared/attachment-storage.ts` 的 `formatBytes` 逐字一致。两端各留一份是
 * 有意的:前端不引服务端代码,而这点逻辑不值得为它引一层共享包。有 `formatBytes.test.ts`
 * 钉住两边同答案。
 *
 * KB 用整数、MB / GB 用一位小数:KB 档的小数位在 UI 上只是噪声(1.3 KB 和 1 KB 对用户是
 * 同一个信息),而 MB 以上一位小数才分得出 1.2GB 和 1.9GB。
 */
export function formatBytes(bytes?: number | null): string {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

/** KB 入参的便利包装(/api/system/status 有几个字段是以 KB 计的)。 */
export function formatKilobytes(kilobytes?: number | null): string {
  return formatBytes((Number(kilobytes) || 0) * 1024);
}
