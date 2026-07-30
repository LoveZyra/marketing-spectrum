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

  const blocks = docs.filter((doc) => !isPathDoc(doc)).map((doc) => {
    const attrs = [`name="${doc.name.replace(/"/g, "'")}"`, `source="${doc.source}"`];
    if (doc.url) attrs.push(`url="${doc.url.replace(/"/g, "'")}"`);
    if (doc.truncated) attrs.push('truncated="true"');
    return `<attached-document ${attrs.join(' ')}>\n${doc.text}\n</attached-document>`;
  });

  let suffix = '';
  if (paths.length > 0) suffix += `\n${paths.join('\n')}`;
  if (blocks.length > 0) suffix += `\n\n${blocks.join('\n\n')}`;
  return suffix;
}
