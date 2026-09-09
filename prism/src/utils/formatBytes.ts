/**
 * 字节数的**唯一**展示口径。
 *
 * ## 为什么要有这个文件
 *
 * 这个仓库里曾经有四份 `formatBytes` / `formatFileSize`,而其中两份
 * (`ServerStatusTab` 与它的子组件 `RuntimeStatsSection`)**渲染在同一个设置面板里**
 * —— 上下并排,MB 档一个 `.toFixed(0)` 一个 `.toFixed(1)`,肉眼就能看见不一致。
 * `ServerStatusTab` 那份还缺 `< 1KB` 分支,几百字节会显示成 `0 KB`;
 * 技能页那份没有 GB 档,超过 1GB 会印出 `1024.0 MB`。
 *
 * 这是"同一件事两套代码"最无害也最典型的样本 —— 没有安全后果,但它证明了
 * 抄一遍就会漂,而且漂了没人发现。
 *
 * ## 口径
 *
 * 与服务端 `server/shared/attachment-storage.ts` 的 `formatBytes` **逐字一致**
 * (那份是四档最全的)。两端各留一份是有意的:前端不引服务端代码,而这点逻辑
 * 不值得为它引一层共享包。有 `formatBytes.test.ts` 钉住两边同答案。
 *
 * KB 用整数、MB/GB 用一位小数:KB 档的小数位在 UI 上只是噪声(1.3 KB 和 1 KB
 * 对用户是同一个信息),而 MB 以上一位小数才分得出 1.2GB 和 1.9GB。
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
