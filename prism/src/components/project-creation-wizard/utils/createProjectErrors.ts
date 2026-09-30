/**
 * hl(P3 中英混排):服务端建项目的错误码 → 界面语言。未登记的码原文透传(总比吞掉强)。
 */
export const CREATE_PROJECT_ERROR_CODES: Record<string, string> = {
  PROJECT_PATH_REQUIRED: '请填写项目路径',
  INVALID_PROJECT_PATH: '项目路径无效,或不在允许的工作区范围内',
  PROJECT_PATH_NOT_DIRECTORY: '这个路径已存在,但不是文件夹',
  PROJECT_ALREADY_EXISTS: '这个路径已经是一个项目了',
  INVALID_PROJECT_VISIBILITY: '可见性设置无效',
  INVALID_TEMPLATE_ID: '模板名不合法',
  TEMPLATE_NOT_FOUND: '模板不存在',
  TEMPLATE_HAS_SYMLINK: '模板里含有符号链接,已拒绝',
  TEMPLATE_TOO_MANY_FILES: '模板文件太多',
  TEMPLATE_TOO_LARGE: '模板太大',
};
