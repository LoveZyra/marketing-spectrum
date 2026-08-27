import { authenticatedFetch } from './api';

export type SessionExportFormat = 'md' | 'html' | 'json';

export type SessionExportOptions = {
  /** 默认 md —— 给人读的那种。 */
  format?: SessionExportFormat;
  /**
   * 带上工具调用与结果。默认关:多数导出是给人看的,工具过程是噪音。
   * 排查"它当时到底改了哪个文件"时打开。
   */
  includeTools?: boolean;
};

/**
 * 导出会话并触发浏览器下载。
 *
 * 走 authenticatedFetch(带 JWT)→ blob → objectURL —— 不能用裸 <a href>,
 * 那样带不上 Authorization。文件名交给服务端的 Content-Disposition。
 * (从 SidebarSessionItem 提为共享工具:侧栏会话行与主区顶栏的导出按钮共用。)
 */
export async function downloadSessionExport(
  sessionId: string,
  fallbackName: string,
  options: SessionExportOptions = {},
): Promise<void> {
  const format = options.format ?? 'md';
  const params = new URLSearchParams({ format });
  if (options.includeTools) params.set('includeTools', 'true');

  const response = await authenticatedFetch(
    `/api/providers/sessions/${encodeURIComponent(sessionId)}/export?${params.toString()}`,
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const utf8Match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  const asciiMatch = /filename="([^"]+)"/.exec(disposition);
  const fileName = utf8Match
    ? decodeURIComponent(utf8Match[1])
    : asciiMatch
      ? asciiMatch[1]
      : `${fallbackName}.${format}`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
