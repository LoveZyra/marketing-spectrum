import path from 'node:path';

/**
 * Content types served from published pages.
 *
 * A whitelist, not a lookup table: anything not named here is served as
 * `application/octet-stream` with an attachment disposition. The route is
 * unauthenticated, so an extension the browser decides to execute in the
 * origin's context — `.svg` is the classic — has to be a deliberate entry
 * rather than whatever a generic mime library happens to return.
 *
 * SVG is included because published reports embed charts as SVG, and the
 * response carries `nosniff` plus a CSP that blocks scripts from other origins.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8',
};

export const DOWNLOAD_CONTENT_TYPE = 'application/octet-stream';

export type ResolvedContentType = {
  contentType: string;
  /** True when the type is not whitelisted and must be forced to download. */
  forceDownload: boolean;
};

export function contentTypeFor(filePath: string): ResolvedContentType {
  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
  return contentType
    ? { contentType, forceDownload: false }
    : { contentType: DOWNLOAD_CONTENT_TYPE, forceDownload: true };
}

export function isHtml(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === '.html' || extension === '.htm';
}

/**
 * Turn the wildcard tail of `/p/:token/<tail>` into a project-relative path.
 *
 * Returns null for anything that tries to climb: a `..` segment, an absolute
 * path, a Windows drive letter, or a NUL byte. This runs before
 * `validatePathInProject`, not instead of it — that one is the boundary that
 * actually holds, including against symlinks. This is the cheap first pass, and
 * it exists so an obviously hostile URL never reaches the filesystem at all.
 */
export function normalizePublicSubPath(rawTail: string): string | null {
  if (!rawTail) return '';
  if (rawTail.includes('\0')) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawTail);
  } catch {
    // Malformed percent-encoding. Nothing legitimate produces it.
    return null;
  }

  if (decoded.includes('\0')) return null;

  const normalized = decoded.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;

  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) return null;

  return segments.join('/');
}

/**
 * `<base href>` to inject into published HTML.
 *
 * Without it, a page opened at `/p/<token>/report.html` and embedded elsewhere
 * resolves its own `#anchor` links against the *host* page's URL, so clicking a
 * table-of-contents link navigates away instead of scrolling — which is exactly
 * the bug reported against the shared diagnosis reports. Pinning the base to
 * the publication's own directory makes both anchors and relative assets
 * resolve within the published tree.
 */
export function publicBaseHref(token: string, kind: 'file' | 'folder', subPath: string): string {
  if (kind === 'file') {
    return `/p/${token}/`;
  }

  const directory = subPath.includes('/') ? subPath.slice(0, subPath.lastIndexOf('/') + 1) : '';
  return `/p/${token}/${directory}`;
}

const HEAD_OPEN = /<head(\s[^>]*)?>/i;

/**
 * Insert `<base href>` as the first thing in `<head>`.
 *
 * Position matters: `<base>` only affects elements that come after it, so
 * appending it would leave any stylesheet or script already declared in the
 * head resolving against the wrong URL. When the document has no `<head>` at
 * all — fragments do happen — the tag is prepended, which browsers hoist into
 * the implicit head during parsing.
 *
 * A document that already declares its own `<base>` is left alone. Overriding
 * it would break a page that was authored to be hosted somewhere specific, and
 * that is the author's call to make, not ours.
 */
export function injectBaseHref(html: string, baseHref: string): string {
  if (/<base\s/i.test(html)) {
    return html;
  }

  const tag = `<base href="${baseHref}">`;
  const match = HEAD_OPEN.exec(html);
  if (!match) {
    return `${tag}\n${html}`;
  }

  const insertAt = match.index + match[0].length;
  return `${html.slice(0, insertAt)}\n    ${tag}${html.slice(insertAt)}`;
}

/**
 * CSP for published pages.
 *
 * Deliberately permissive about inline script and style: the pages being
 * published are agent-generated reports that inline everything, and a policy
 * they cannot satisfy would just be turned off. What it does buy is blocking
 * script and frame loads from other origins, so a published page cannot become
 * a delivery vehicle for someone else's code, and `frame-ancestors *` keeps the
 * embedding use case working.
 */
export const PUBLISHED_PAGE_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' 'unsafe-inline' data:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors *",
].join('; ');

/**
 * CSP for the editor's preview iframe.
 *
 * Tighter than the published-page policy in the one way that matters here:
 * `frame-ancestors 'self'` — a preview URL is meant to be looked at inside
 * Prism, and there is no reason for one to be embeddable elsewhere while its
 * ticket is alive. Inline script and style stay allowed for the same reason as
 * on the public side: the documents being previewed inline everything, and a
 * policy that breaks them would just be switched off.
 */
export const PREVIEW_PAGE_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' 'unsafe-inline' data:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
].join('; ');
