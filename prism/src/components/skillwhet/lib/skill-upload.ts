/**
 * 上传技能:把浏览器选中的一个文件夹变成 `POST /api/skillwhet/skills/upload` 的载荷。
 *
 * 载荷形状与 SkillWhet `ManagedStore.import_upload` 对齐:`{ name, files: [{ rel, content_b64 }] }`。
 * 这里只做前置把关(定位 SKILL.md 所在的技能根、目录名合法、数量与体积上限、滤掉 `.evo/` 等噪音目录),
 * 服务端再校一遍并做路径穿越检查;前端先拦是为了省掉一次最多 30 MiB 的白传。
 */
import { swText } from './sw-text';

export const MAX_UPLOAD_FILES = 500;
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
export const MAX_UPLOAD_FILE_BYTES = 5 * 1024 * 1024;

export type UploadFile = { rel: string; content_b64: string };
export type UploadBundle = {
  name: string; files: UploadFile[]; totalBytes: number; hasUnitTests: boolean; pythonFiles: number;
  /** SKILL.md 不在所选文件夹的根、而在这个子目录里;页面据此明确提示技能名取自子目录 */
  nestedRoot?: string;
  /** 所选文件夹自己的名字(与 name 不同时才有意义) */
  pickedFolder?: string;
};

type BrowserFile = File & { webkitRelativePath?: string };

const relativePathOf = (file: BrowserFile): string => (file.webkitRelativePath || file.name).replace(/\\/g, '/');

const readBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const result = typeof reader.result === 'string' ? reader.result : '';
    const separator = result.indexOf(',');
    resolve(separator >= 0 ? result.slice(separator + 1) : result);
  };
  reader.onerror = () => reject(reader.error ?? new Error(swText('skillwhet:upload.err.read', '读不了 {{name}}', { name: file.name })));
  reader.readAsDataURL(file);
});

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.evo', '.pytest_cache', '.mypy_cache', '.ruff_cache']);

/**
 * 从选中的文件里找 skill 根(含 SKILL.md 的最浅目录),裁掉根前缀,过滤噪音目录。
 * 只接受一个 skill:还有 SKILL.md 不在这个根之下时报错,让用户分开传。
 */
export async function buildUploadBundle(selected: File[]): Promise<UploadBundle> {
  const files = (selected as BrowserFile[]).map((file) => ({ file, rel: relativePathOf(file) }));
  const roots = files
    .filter(({ rel }) => rel.split('/').pop()?.toLowerCase() === 'skill.md')
    .map(({ rel }) => rel.split('/').slice(0, -1).join('/'))
    .sort((a, b) => a.length - b.length);
  if (roots.length === 0) throw new Error(swText('skillwhet:upload.err.noSkillMd', '选中的文件夹里没有 SKILL.md'));
  const root = roots[0];
  const nested = roots.filter((candidate) => candidate !== root && !candidate.startsWith(`${root}/`));
  if (nested.length > 0) throw new Error(swText('skillwhet:upload.err.multiple', '一次只能上传一个 skill(选中了多个 SKILL.md)'));
  const name = root ? root.split('/').pop() ?? '' : '';
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(swText('skillwhet:upload.err.badName', '技能目录名不合法:{{name}} —— 只允许字母、数字、. _ -,且 SKILL.md 要在目录根', { name: name || swText('skillwhet:upload.err.empty', '(空)') }));
  }
  // 浏览器给的相对路径第一段就是用户选的那个文件夹;SKILL.md 在更深一层时 root 有多段
  const pickedFolder = files[0]?.rel.split('/')[0] ?? '';
  const nestedRoot = root.includes('/') ? root : undefined;
  const kept = files
    .filter(({ rel }) => rel === `${root}/SKILL.md` || rel.startsWith(root ? `${root}/` : ''))
    .map(({ file, rel }) => ({ file, rel: root ? rel.slice(root.length + 1) : rel }))
    .filter(({ rel }) => !rel.split('/').some((segment) => SKIP_DIRS.has(segment)));
  if (kept.length > MAX_UPLOAD_FILES) throw new Error(swText('skillwhet:upload.err.tooMany', '文件数超过 {{n}}', { n: MAX_UPLOAD_FILES }));
  const totalBytes = kept.reduce((sum, { file }) => sum + file.size, 0);
  if (totalBytes > MAX_UPLOAD_BYTES) throw new Error(swText('skillwhet:upload.err.tooBig', '总体积超过 {{mib}} MiB', { mib: MAX_UPLOAD_BYTES / (1024 * 1024) }));
  const oversize = kept.find(({ file }) => file.size > MAX_UPLOAD_FILE_BYTES);
  if (oversize) throw new Error(swText('skillwhet:upload.err.fileTooBig', '{{rel}} 超过单文件 {{mib}} MiB', { rel: oversize.rel, mib: MAX_UPLOAD_FILE_BYTES / (1024 * 1024) }));
  const encoded: UploadFile[] = [];
  for (const { file, rel } of kept) {
    encoded.push({ rel, content_b64: await readBase64(file) });
  }
  return {
    name,
    files: encoded,
    totalBytes,
    ...(nestedRoot ? { nestedRoot, pickedFolder } : {}),
    hasUnitTests: kept.some(({ rel }) => rel.startsWith('tests/unit/')),
    pythonFiles: kept.filter(({ rel }) => rel.endsWith('.py')).length,
  };
}
