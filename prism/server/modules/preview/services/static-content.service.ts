import path from 'node:path';

/**
 * Content types served from the editor's preview route.
 *
 * A whitelist, not a lookup table: anything not named here is served as
 * `application/octet-stream` with an attachment disposition. The preview route
 * answers with only a short-lived ticket rather than a session, so an extension
 * the browser decides to execute in the origin's context — `.svg` is the
 * classic — has to be a deliberate entry rather than whatever a generic mime
 * library happens to return.
 *
 * SVG is included because previewed reports embed charts as SVG, and the
 * response carries `nosniff` plus a CSP that blocks scripts from other origins.
 *
 * These helpers used to live in `modules/publish`. That feature was removed;
 * the *rules* were not, because they are the load-bearing part — a MIME
 * whitelist and a path normalizer are what keep a file-serving route from
 * becoming a stored-XSS vector. They moved here rather than being deleted with
 * their old owner.
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

/**
 * Turn a wildcard URL tail into a project-relative path.
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
 * CSP for the editor's preview iframe.
 *
 * `frame-ancestors 'self'` — a preview URL is meant to be looked at inside
 * Prism, and there is no reason for one to be embeddable elsewhere while its
 * ticket is alive. Inline script and style stay allowed because the documents
 * being previewed inline everything, and a policy that breaks them would just
 * be switched off.
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
