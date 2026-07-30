import { useCallback, useState, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ErrorBoundary as ReactErrorBoundary,
  type FallbackProps,
} from 'react-error-boundary';

/**
 * App-wide error boundary.
 *
 * This lived under `main-content/view/` and had exactly one consumer — the chat
 * pane — which is why its fallback copy used to read "An error occurred while
 * loading the chat interface" no matter what it wrapped. Every lazily-loaded
 * panel is wrapped now, so the copy is generic and the caller passes a `label`
 * (already-translated) naming the thing that failed.
 *
 * A thrown chunk-load error reaches here too: when the network drops between
 * app load and the first time a user opens, say, the Git tab, `React.lazy`
 * rejects and the boundary catches it. "Try Again" remounts the subtree, which
 * re-triggers the import — so the retry is meaningful and not just cosmetic.
 */

type ErrorFallbackProps = FallbackProps & {
  showDetails: boolean;
  componentStack: string | null;
  label?: string;
};

type ErrorBoundaryProps = {
  children: ReactNode;
  /** Human-readable name of the wrapped area, used in the fallback copy. */
  label?: string;
  showDetails?: boolean;
  onRetry?: () => void;
  resetKeys?: unknown[];
};

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

function ErrorFallback({
  error,
  resetErrorBoundary,
  showDetails,
  componentStack,
  label,
}: ErrorFallbackProps) {
  const { t } = useTranslation('common');

  return (
    <div className="flex flex-col items-center justify-center p-8 text-center" role="alert">
      <div className="max-w-md rounded-lg border border-red-200 bg-red-50 p-6 dark:border-red-900/50 dark:bg-red-950/30">
        <div className="mb-4 flex items-center">
          <div className="flex-shrink-0">
            <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <h3 className="ml-3 text-sm font-medium text-red-800 dark:text-red-200">
            {t('errorBoundary.title', { defaultValue: 'Something went wrong' })}
          </h3>
        </div>
        <div className="text-sm text-red-700 dark:text-red-300">
          <p className="mb-2">
            {label
              ? t('errorBoundary.messageWithLabel', {
                  label,
                  defaultValue: 'An error occurred while loading {{label}}.',
                })
              : t('errorBoundary.message', { defaultValue: 'An error occurred while loading this area.' })}
          </p>
          {showDetails && (
            <details className="mt-4">
              <summary className="cursor-pointer font-mono text-xs">
                {t('errorBoundary.details', { defaultValue: 'Error Details' })}
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto rounded bg-red-100 p-2 text-left text-xs dark:bg-red-900/40">
                {formatError(error)}
                {componentStack}
              </pre>
            </details>
          )}
        </div>
        <div className="mt-4">
          <button
            onClick={resetErrorBoundary}
            className="rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            {t('errorBoundary.retry', { defaultValue: 'Try Again' })}
          </button>
        </div>
      </div>
    </div>
  );
}

function ErrorBoundary({
  children,
  label = undefined,
  showDetails = false,
  onRetry = undefined,
  resetKeys = undefined,
}: ErrorBoundaryProps) {
  const [componentStack, setComponentStack] = useState<string | null>(null);

  const handleError = useCallback((error: Error, errorInfo: ErrorInfo) => {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    // Keep component stack for optional debug rendering in fallback UI.
    setComponentStack(errorInfo?.componentStack ?? null);
  }, []);

  const handleReset = useCallback(() => {
    setComponentStack(null);
    onRetry?.();
  }, [onRetry]);

  const renderFallback = useCallback(
    ({ error, resetErrorBoundary }: FallbackProps) => (
      <ErrorFallback
        error={error}
        resetErrorBoundary={resetErrorBoundary}
        showDetails={showDetails}
        componentStack={componentStack}
        label={label}
      />
    ),
    [showDetails, componentStack, label]
  );

  return (
    <ReactErrorBoundary
      fallbackRender={renderFallback}
      onError={handleError}
      onReset={handleReset}
      resetKeys={resetKeys}
    >
      {children}
    </ReactErrorBoundary>
  );
}

export default ErrorBoundary;
