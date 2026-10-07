/**
 * 把一个服务端 URL 交给浏览器自己下。
 *
 * 不用 `fetch` → `response.blob()` → `a[download]`:那样整份文件先落进标签页的内存,
 * 拼完才弹保存框,下载期间没有进度、切页或刷新就断、几 GB 的文件能把标签页撑崩、也不能暂停续传。
 * 让浏览器自己导航那个 URL,下载栏立刻出现,字节边收边落盘。代价是一次普通导航设不了
 * `Authorization` 头,所以 URL 里得带一张短命票据(见 `server/shared/download-tickets.js`)。
 *
 * 用隐藏 iframe 而不是 `a.click()`:点同源的 `<a href>` 时浏览器先导航过去,看到
 * `Content-Disposition: attachment` 才转成下载;响应不是附件时页面就真的跳走了。下载票存在
 * 服务端内存里,服务重启会让它消失,这时导航拿到一份 401 JSON,整个 SPA 状态跟着没了。
 * 放进 iframe,失败那份 JSON 落在看不见的地方,页面一动不动。拿不到失败回调可以接受:
 * 真正的失败(权限、路径、文件不存在)都在签票那一步挡掉,那一步还在 `fetch` 语境里,能正常弹提示。
 */
export function startBrowserDownload(url: string): void {
  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  frame.setAttribute('aria-hidden', 'true');
  frame.src = url;
  document.body.appendChild(frame);

  /**
   * 下载交给浏览器之后这个 iframe 就没用了,但不能马上移除:响应头还没回来时
   * 移除会把这次导航一起取消,而且不报错 —— 和 blob 那边"同步 revokeObjectURL 掐死
   * 大文件"是同一类错误。60 秒是给慢响应留的余量;头一旦回来,下载就归下载管理器了,
   * 之后移不移除都不影响。
   */
  window.setTimeout(() => frame.remove(), 60_000);
}
