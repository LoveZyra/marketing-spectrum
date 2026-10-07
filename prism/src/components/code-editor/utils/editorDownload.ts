/**
 * 编辑器「下载」按钮下的是什么。
 *
 * - 读失败:什么都不下(缓冲区里是错误注释,不是文件);
 * - diff 视图:只有缓冲区(new_string 片段),没有对应的磁盘文件可签票;
 * - 有未保存改动:下缓冲区,否则用户改了半天点「下载」拿到的是改之前的版本;
 * - 签不了票(既没有项目也不是会话产出):下缓冲区;
 * - 其余:签票直传磁盘原件(有进度、大文件不经标签页内存、GBK 这类只读文件拿到的是原字节)。
 */
export type EditorDownloadSource = 'blocked' | 'buffer' | 'ticket';

export function chooseEditorDownload(state: {
  loadError: boolean;
  isDiffView: boolean;
  hasUnsavedChanges: boolean;
  canIssueTicket: boolean;
}): EditorDownloadSource {
  if (state.loadError) return 'blocked';
  if (state.isDiffView || state.hasUnsavedChanges || !state.canIssueTicket) return 'buffer';
  return 'ticket';
}
