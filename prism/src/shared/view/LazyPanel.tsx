import { Suspense, type ReactNode } from 'react';

import ErrorBoundary from './ErrorBoundary';

/**
 * Wrapper for the code-split panels that fill the main content area.
 *
 * Each of those panels is already conditionally rendered — the Git tab only
 * mounts when the Git tab is open — so making them `React.lazy` costs nothing
 * at runtime and keeps their dependencies out of the initial bundle. That
 * matters here specifically: the terminal (xterm, ~400 kB) and the code editor
 * (CodeMirror, ~660 kB) together were most of a 2.3 MB entry chunk that every
 * visitor downloaded before the chat view could paint, including over LAN on a
 * phone, which is a supported way to use this app.
 *
 * `React.lazy` throws a promise on first render (handled by Suspense) and
 * throws a real error if the chunk fetch fails (handled by ErrorBoundary), so
 * both are required — a lazy component with only one of them is a white screen
 * waiting to happen.
 */

type LazyPanelProps = {
  children: ReactNode;
  /** Already-translated name of this panel, shown if its chunk fails to load. */
  label?: string;
  /** Fill the parent's height. Panels that own the content area want this. */
  fullHeight?: boolean;
};

export function PanelLoadingFallback({ fullHeight = true }: { fullHeight?: boolean }) {
  return (
    <div className={`flex ${fullHeight ? 'h-full' : 'py-8'} items-center justify-center`}>
      <div
        className="h-8 w-8 rounded-full border-[3px] border-muted border-t-primary"
        style={{ animation: 'spin 1s linear infinite' }}
        role="status"
        aria-label="Loading"
      />
    </div>
  );
}

/**
 * Suspense fallback for lazily-loaded modals.
 *
 * Modals are rendered into a portal on `document.body`, so `PanelLoadingFallback`
 * is wrong for them: it lays out in normal flow and would flash a bare spinner
 * below the page content instead of over it. This paints the same dimmed
 * backdrop the modal itself will use, so the click that opened the modal is
 * acknowledged immediately and the chunk arriving is a swap, not a jump.
 */
export function ModalLoadingFallback() {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-50">
      <div
        className="h-8 w-8 rounded-full border-[3px] border-white/30 border-t-white"
        style={{ animation: 'spin 1s linear infinite' }}
        role="status"
        aria-label="Loading"
      />
    </div>
  );
}

export default function LazyPanel({ children, label, fullHeight = true }: LazyPanelProps) {
  return (
    <ErrorBoundary label={label} showDetails>
      <Suspense fallback={<PanelLoadingFallback fullHeight={fullHeight} />}>{children}</Suspense>
    </ErrorBoundary>
  );
}
