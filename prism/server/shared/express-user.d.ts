import type { Viewer } from './types.js';

/**
 * Teaches TypeScript that `authenticateToken` puts a user on the request, so
 * every route reads one shared `req.user` shape instead of casting `req` to an
 * ad-hoc type that can silently disagree with what the middleware sets.
 *
 * Optional on purpose: routes mounted before the auth middleware, and the
 * platform-mode paths, genuinely have no user. Making it required would push
 * every call site into a non-null assertion, which is the same hole with more
 * ceremony.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id?: Viewer['userId'];
        username?: string;
        isRoot?: boolean;
      };
    }
  }
}

export {};
