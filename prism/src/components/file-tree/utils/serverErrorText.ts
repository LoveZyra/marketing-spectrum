/**
 * hl(P3 中英混排):文件接口的英文错误 → 界面语言。
 *
 * 服务端的文件路由(files.routes.ts)是从 upstream 搬来的,错误文案全是英文
 * (`Directory already exists`、`A file or directory with this name already exists`…),
 * 而文件树把 `data.error` 原样塞进 toast。改服务端会牵动 API 调用方与既有测试,
 * 所以在展示层按**原句**映射:认得的翻成当前语言,认不得的原样透传(总比吞掉强)。
 *
 * 键放在 common:fileTree.serverErrors.* 下,`t` 由调用方传入(它已经绑定了当前语言)。
 */

type Translate = (key: string, options: { defaultValue: string }) => string;

const KNOWN: Array<{ match: RegExp; key: string; zh: string }> = [
  { match: /^Directory already exists$/i, key: 'directoryExists', zh: '同名文件夹已存在' },
  { match: /^File already exists$/i, key: 'fileExists', zh: '同名文件已存在' },
  { match: /^A file or directory with this name already exists$/i, key: 'nameExists', zh: '已存在同名的文件或文件夹' },
  { match: /^File or directory not found$/i, key: 'notFound', zh: '文件或文件夹不存在(可能已被删除或改名)' },
  { match: /^File not found$/i, key: 'fileNotFound', zh: '文件不存在' },
  { match: /^Permission denied$/i, key: 'permissionDenied', zh: '没有权限执行这个操作' },
  { match: /^Project not found$/i, key: 'projectNotFound', zh: '项目不存在或你没有访问权限' },
  { match: /^Parent directory not found$/i, key: 'parentNotFound', zh: '上级文件夹不存在' },
  { match: /^Directory is not empty$/i, key: 'notEmpty', zh: '文件夹不是空的' },
  { match: /^Cannot delete project root directory$/i, key: 'cannotDeleteRoot', zh: '不能删除项目根目录' },
  { match: /^Cannot move across different filesystems$/i, key: 'crossDevice', zh: '不能跨文件系统移动' },
  { match: /^Invalid file path$/i, key: 'invalidPath', zh: '文件路径无效' },
  { match: /^Path is not a directory$/i, key: 'notDirectory', zh: '这个路径不是文件夹' },
  { match: /^Unsupported file type$/i, key: 'unsupportedType', zh: '不支持的文件类型' },
  { match: /^No files provided$/i, key: 'noFiles', zh: '没有选择任何文件' },
  { match: /^Too many files\./i, key: 'tooManyFiles', zh: '一次上传的文件太多' },
  { match: /^File too large\./i, key: 'fileTooLarge', zh: '文件太大,超过单文件上限' },
  { match: /^Upload too large\./i, key: 'uploadTooLarge', zh: '这批文件总量超过上限' },
  { match: /^Upload session not found or expired/i, key: 'uploadExpired', zh: '上传会话已过期,请重新上传' },
  { match: /^Incomplete upload:/i, key: 'uploadIncomplete', zh: '上传不完整(有分片丢失),已作废,请重试' },
  { match: /^Failed to rename$/i, key: 'renameFailed', zh: '重命名失败' },
  { match: /^Failed to delete$/i, key: 'deleteFailed', zh: '删除失败' },
  { match: /^Failed to create$/i, key: 'createFailed', zh: '创建失败' },
  { match: /^Upload failed\. Check your connection and try again\.$/i, key: 'uploadNetwork', zh: '上传失败,请检查网络后重试' },
  { match: /^Upload canceled\.$/i, key: 'uploadCanceled', zh: '上传已取消' },
];

export function describeFileServerError(raw: unknown, t: Translate): string {
  const message = typeof raw === 'string' ? raw.trim() : '';
  if (!message) return t('fileTree.serverErrors.unknown', { defaultValue: '操作失败' });
  for (const entry of KNOWN) {
    if (entry.match.test(message)) {
      return t(`fileTree.serverErrors.${entry.key}`, { defaultValue: entry.zh });
    }
  }
  return message;
}
