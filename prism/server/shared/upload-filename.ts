/**
 * multipart 上传文件名的编码恢复。
 *
 * ## 问题
 *
 * multer 底下是 busboy,而 busboy 解 `Content-Disposition` 里的 `filename` 参数
 * 用的默认字符集是 **latin1**(`defParamCharset: 'latin1'`)。浏览器发的是 UTF-8
 * 字节,于是每个 UTF-8 字节被当成一个 latin1 字符:`附件.png` 到了
 * `file.originalname` 上是 `é™„ä»¶.png`(`e9 99 84 e4 bb b6` 六个字节变六个字符)。
 *
 * 这不是"显示得难看"而已 —— 名字会**以乱码落盘**(文件树上传、附件目录都在项目
 * 文件树里明着摆),也会顺着上传响应回到前端,用户在自己的文件树里再也认不出那个文件。
 *
 * ## 判据
 *
 * 只有"看起来确实是被当 latin1 读过的 UTF-8"才动:
 *
 *   1. 出现任何码点 > 0xFF → 已经是正常 Unicode,原样返回(绝不碰);
 *   2. 全部码点 ≤ 0x7F → 纯 ASCII,没什么可恢复的,原样返回;
 *   3. 否则按 latin1 取回字节、按 UTF-8 解,并且**只在往返无损时**采用 ——
 *      解出来再编回去必须与原字节完全相同。孤立的 0xE9(真的 latin1 名字
 *      `café.txt`)解 UTF-8 会得到替换字符,编回去对不上,于是保持原样。
 *
 * 第 3 条挡掉了绝大多数误伤,但它不是定理:`Ã©` 这种本身就是合法 UTF-8 序列的
 * 两字符组合会被"恢复"成 `é`。这是这类启发式共有的歧义,也正是**只该把它用在
 * multipart 的 filename 参数上**的原因 —— 表单字段值(`req.body.*`)由 busboy 按
 * `defCharset`(默认 utf8)解,JSON body 更是早就正确解过,那些地方本来就没有这个
 * 病,再套一层只会白担第 3 条的风险。
 *
 * 历史:这段判据原来写死在 `server/routes/documents.js` 里(文档解析那条上传路),
 * 于是**只有文档上传**的中文名是好的,图片附件(assets)与文件树上传(files)两条
 * 路都是拿 `file.originalname` 原样用 —— 同一个 multer、同一个坑。2026-09-15 提到
 * shared 层,三条路共用一份。
 */

/**
 * 把被当成 latin1 读进来的 UTF-8 文件名恢复回真正的名字。
 *
 * 只用于 multipart 的 `filename` 参数(multer 的 `file.originalname`)。
 * 拿不到名字时给空串(调用方自己决定兜底名,`recoverUploadFilename(x) || '文件'`)。
 */
export function recoverUploadFilename(name: string | null | undefined): string {
  if (!name) return '';
  let needsFix = false;
  for (const ch of name) {
    const cp = ch.codePointAt(0) as number;
    if (cp > 0xFF) return name; // 已经是正常 Unicode —— 不碰
    if (cp >= 0x80) needsFix = true;
  }
  if (!needsFix) return name; // 纯 ASCII
  try {
    const buf = Buffer.from(name, 'latin1');
    const decoded = buf.toString('utf8');
    // 往返无损才采用:否则它本来就是个真的 latin1 名字。
    if (Buffer.from(decoded, 'utf8').equals(buf)) return decoded;
    return name;
  } catch {
    return name;
  }
}
