/**
 * prism: how attachments are spliced into the outgoing prompt.
 *
 * Kept apart from the composer's state machine because this is the piece that
 * decides what the model actually reads, and it is worth being able to test
 * that decision without standing up a React hook.
 */

/** prism: one parsed document (or fetched URL) attached to the next send. */
export interface AttachedDoc {
  name: string;
  text: string;
  chars: number;
  truncated?: boolean;
  source: 'file' | 'url';
  url?: string;
  /**
   * How `text` should be spliced into the outgoing prompt.
   *
   * 'path' — `text` IS a staged disk path (generic attach button via /land, and
   *   the .html branch of /parse). There is no document body to delimit, so the
   *   path is concatenated onto the prompt as a bare line: an
   *   <attached-document> envelope around a single path is pure noise in the
   *   transcript and in the model's context.
   * 'text' — `text` is extracted document content (PDF/DOCX/… via /parse, or a
   *   fetched URL). That DOES need the envelope: it marks where untrusted
   *   third-party text starts and stops, which is the boundary
   *   escapeAttachedDocumentTags() on the server exists to protect.
   */
  kind?: 'path' | 'text';
  /**
   * ed:落盘附件顺带抽出的正文(服务端 /land 对 ≤20MB 的 PDF / Office / 文本类型
   * 就地抽取)。有它就在路径行之外再附一个 <attached-document> 块 —— 模型不用先
   * 调工具就能读到内容;路径仍给智能体做工具处理。
   */
  extractedText?: string;
  extractedChars?: number;
  extractedTruncated?: boolean;
}

/** A doc whose `text` is a disk path rather than a document body. */
export function isPathDoc(doc: AttachedDoc): boolean {
  return doc.kind === 'path';
}

/**
 * Build the suffix appended to the user's prompt for the current attachments.
 *
 * Path attachments come first and unadorned — `<prompt>\n<path>` — because the
 * agent reads them as "operate on this file" and any wrapper just gets in the
 * way. Content attachments keep the tagged envelope.
 *
 * The return value always starts with a newline (or is empty), so callers
 * append it to the typed input directly: `currentInput + buildDocsBlock(docs)`.
 */
export function buildDocsBlock(docs: AttachedDoc[]): string {
  if (docs.length === 0) return '';

  const paths = docs
    .filter(isPathDoc)
    .map((doc) => doc.text.trim())
    .filter(Boolean);

  const envelope = (doc: AttachedDoc, body: string, truncated: boolean | undefined, pathAttr?: string) => {
    const attrs = [`name="${doc.name.replace(/"/g, "'")}"`, `source="${doc.source}"`];
    if (doc.url) attrs.push(`url="${doc.url.replace(/"/g, "'")}"`);
    if (pathAttr) attrs.push(`path="${pathAttr.replace(/"/g, "'")}"`);
    if (truncated) attrs.push('truncated="true"');
    return `<attached-document ${attrs.join(' ')}>\n${body}\n</attached-document>`;
  };

  const blocks = docs.filter((doc) => !isPathDoc(doc)).map((doc) => envelope(doc, doc.text, doc.truncated));
  // 落盘附件抽到了正文的,也附一个信封(带 path 属性,让模型知道正文对应盘上哪个文件)。
  for (const doc of docs) {
    if (isPathDoc(doc) && doc.extractedText && doc.extractedText.trim()) {
      blocks.push(envelope(doc, doc.extractedText, doc.extractedTruncated, doc.text.trim()));
    }
  }

  let suffix = '';
  if (paths.length > 0) suffix += `\n${paths.join('\n')}`;
  if (blocks.length > 0) suffix += `\n\n${blocks.join('\n\n')}`;
  return suffix;
}
