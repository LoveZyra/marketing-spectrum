/**
 * 把一个**服务端 URL** 交给浏览器自己下。
 *
 * ## 和原来那套的区别
 *
 * 原来是 `fetch` → `response.blob()` → `a[download]`:整份文件**先落进标签页的内存**,
 * 拼完才弹保存框。代价有四条 —— 下载期间页面完全没反应(没有进度条)、切页或刷新
 * 就断、几 GB 的文件直接把标签页撑崩、暂停续传一概没有。
 *
 * 让浏览器自己去导航那个 URL,这四条一起消失:下载栏立刻出现,字节边收边落盘,
 * 进度、速度、剩余时间都是浏览器画的。代价是**一次普通导航设不了 `Authorization` 头**,
 * 所以 URL 里得带一张短命票据(见 `server/shared/download-tickets.js`)。
 *
 * ## 为什么用 iframe 而不是 `a.click()`
 *
 * 点一个同源的 `<a href>`,浏览器先**导航**过去,看到 `Content-Disposition: attachment`
 * 才转成下载、把页面留在原地。**但响应不是附件的时候,页面就真的跳走了** ——
 * 下载票存在服务端内存里,服务重启(比如一次发版)会让它凭空消失,这时导航拿到的是
 * 一份 401 JSON,用户的整个 SPA 状态跟着没了。
 *
 * 换成一个隐藏 iframe:成功照样下载,失败那份 JSON 落在看不见的 iframe 里,
 * 页面一动不动。代价是拿不到失败回调 —— 可接受,因为**真正的失败都发生在签票那一步**
 * (权限、路径、文件不存在全在那里挡掉),那一步还在 `fetch` 语境里,能正常弹提示。
 */
export function startBrowserDownload(url: string): void {
  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  frame.setAttribute('aria-hidden', 'true');
  frame.src = url;
  document.body.appendChild(frame);

  /**
   * 下载交给浏览器之后这个 iframe 就没用了,但**不能马上移除**:响应头还没回来时
   * 移除会把这次导航一起取消,而且不报错 —— 和 blob 那边"同步 revokeObjectURL 掐死
   * 大文件"是同一类错误。60 秒是给慢响应留的余量;头一旦回来,下载就归下载管理器了,
   * 之后移不移除都不影响。
   */
  window.setTimeout(() => frame.remove(), 60_000);
}
