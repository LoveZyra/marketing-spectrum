import { authenticatedFetch } from './api';

/**
 * 导出会话为 Markdown 并触发浏览器下载。
 * 走 authenticatedFetch(带 JWT)→ blob → objectURL —— 不能用裸 <a href>,
 * 那样带不上 Authorization。文件名交给服务端的 Content-Disposition。
 * (从 SidebarSessionItem 提为共享工具:侧栏会话行与主区顶栏的导出按钮共用。)
 */
export async function downloadSessionExport(sessionId: string, fallbackName: string): Promise<void> {
  const response = await authenticatedFetch(
    `/api/providers/sessions/${encodeURIComponent(sessionId)}/export?format=md`,
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
      : `${fallbackName}.md`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
