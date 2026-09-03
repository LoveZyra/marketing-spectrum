export type CodeEditorDiffInfo = {
  old_string?: string;
  new_string?: string;
  [key: string]: unknown;
};

export type CodeEditorFile = {
  name: string;
  path: string;
  // DB projectId; used by the editor to build `/api/projects/:projectId/file`
  // URLs for reading and saving content.
  projectId?: string;
  /**
   * ei:这个文件是**某段会话的产出**,而且落在项目目录之外(计划文件、/tmp 脚本…)。
   * 项目文件接口只服务项目根以内,所以这类文件改走会话产出通道读取,并且**只读**
   * (那条路由只提供读,写回不在它的职责里)。
   */
  outputSessionId?: string;
  diffInfo?: CodeEditorDiffInfo | null;
  [key: string]: unknown;
};

export type CodeEditorSettingsState = {
  isDarkMode: boolean;
  wordWrap: boolean;
  minimapEnabled: boolean;
  showLineNumbers: boolean;
  fontSize: string;
};
