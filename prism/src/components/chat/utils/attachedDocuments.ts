/**
 * prism: split a user turn's raw text into the prompt the person typed and the
 * attachment payloads the composer appended to it.
 *
 * Why this exists at render time rather than at send time: the transcript on
 * disk is the single source of truth for a turn, and it stores exactly what
 * was sent to the model — prompt plus attachments, one string. Reconstructing
 * the boundary here keeps the wire format honest (nothing is hidden from the
 * model) while letting the bubble show a 40kB extracted PDF as a one-line chip
 * instead of forty screens of text.
 *
 * Only content attachments are split out. A landed-file attachment is a bare
 * path concatenated onto the prompt (see buildDocsBlock in
 * utils/attachmentPrompt.ts) and stays inline: it is one short line, it is
 * the thing the user is talking about, and there is no reliable way to tell it
 * from a path the user typed themselves — guessing would eat real input.
 */

export type UserMessageSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'document';
      /** Extracted body, exactly as it was sent. */
      text: string;
      name: string;
      source: string;
      url?: string;
      truncated: boolean;
    };

/**
 * Matches one <attached-document …>…</attached-document> envelope.
 *
 * The body is lazy so back-to-back attachments do not collapse into one
 * segment. The server replaces the '<' of any nested closing tag with a
 * fullwidth '＜' (escapeAttachedDocumentTags in server/routes/documents.js),
 * so a document containing the literal tag cannot terminate its own envelope
 * here either.
 */
const ATTACHED_DOCUMENT_RE = /<attached-document\b([^>]*)>\n?([\s\S]*?)\n?<\/attached-document>/g;

/** Pull one double-quoted attribute out of an envelope's attribute string. */
function readAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes);
  return match ? match[1] : undefined;
}

/**
 * Returns the turn's segments in order. A turn with no attachments yields a
 * single text segment, so callers can render the result unconditionally.
 */
export function splitAttachedDocuments(content: string): UserMessageSegment[] {
  const source = String(content ?? '');
  if (!source.includes('<attached-document')) {
    return [{ kind: 'text', text: source }];
  }

  const segments: UserMessageSegment[] = [];
  let cursor = 0;

  // Stateful regex: reset so a module-level literal cannot carry lastIndex
  // across calls.
  ATTACHED_DOCUMENT_RE.lastIndex = 0;
  let match = ATTACHED_DOCUMENT_RE.exec(source);
  while (match !== null) {
    if (match.index > cursor) {
      segments.push({ kind: 'text', text: source.slice(cursor, match.index) });
    }
    const attributes = match[1] || '';
    segments.push({
      kind: 'document',
      text: match[2] || '',
      name: readAttribute(attributes, 'name') || 'attachment',
      source: readAttribute(attributes, 'source') || 'file',
      url: readAttribute(attributes, 'url'),
      truncated: readAttribute(attributes, 'truncated') === 'true',
    });
    cursor = match.index + match[0].length;
    match = ATTACHED_DOCUMENT_RE.exec(source);
  }

  if (cursor < source.length) {
    segments.push({ kind: 'text', text: source.slice(cursor) });
  }

  // The "\n" / "\n\n" joiners buildDocsBlock puts between the prompt and each
  // envelope are formatting, not content. Left in they survive into the bubble,
  // where whitespace-pre-wrap renders them as blank lines above and below every
  // chip — so strip whitespace from each text segment on the side that faces a
  // document, and drop segments that were nothing but a joiner. Whitespace the
  // user typed inside their own prompt is untouched.
  return segments
    .map((segment, index) => {
      if (segment.kind !== 'text') return segment;
      let text = segment.text;
      if (segments[index - 1]?.kind === 'document') text = text.replace(/^\s+/, '');
      if (segments[index + 1]?.kind === 'document') text = text.replace(/\s+$/, '');
      return { ...segment, text };
    })
    .filter((segment) => segment.kind !== 'text' || segment.text.trim().length > 0);
}

/** True when the turn carries at least one content attachment. */
export function hasAttachedDocuments(content: string): boolean {
  return splitAttachedDocuments(content).some((segment) => segment.kind === 'document');
}
