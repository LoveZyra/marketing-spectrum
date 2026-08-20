import { RotateCcw } from 'lucide-react';

type ShellConnectionOverlayProps = {
  mode: 'loading' | 'connect' | 'connecting';
  description: string;
  loadingLabel: string;
  connectLabel: string;
  connectTitle: string;
  connectingLabel: string;
  onConnect: () => void;
};

export default function ShellConnectionOverlay({
  mode,
  description,
  loadingLabel,
  connectLabel,
  connectTitle,
  connectingLabel,
  onConnect,
}: ShellConnectionOverlayProps) {
  if (mode === 'loading') {
    return (
      <div className="absolute inset-0 z-20 flex items-center justify-center bg-muted">
        <div className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
          <span className="h-4 w-4 flex-none rounded-full border-[1.5px] border-primary" aria-hidden="true" />
          <span>{loadingLabel}</span>
        </div>
      </div>
    );
  }

  if (mode === 'connect') {
    return (
      <div className="absolute inset-0 z-20 flex items-center justify-center bg-muted p-6">
        <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
          <button
            type="button"
            onClick={onConnect}
            className="prism-modal-shadow pointer-events-auto inline-flex min-h-12 w-full max-w-xs cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-5 py-3 text-base font-semibold text-primary-foreground ring-offset-background transition-colors hover:bg-primary focus:outline-none focus:ring-2 focus:ring-primary/[0.32] focus:ring-offset-2 active:bg-primary"
            title={connectTitle}
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            <span className="min-w-0 truncate">{connectLabel}</span>
          </button>
          <p className="max-w-md break-words px-2 text-sm leading-6 text-foreground">{description}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-muted p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
        <div className="flex items-center justify-center gap-3 text-muted-foreground">
          <span className="h-5 w-5 flex-none rounded-full border-[1.5px] border-primary" aria-hidden="true" />
          <span className="text-base font-medium">{connectingLabel}</span>
        </div>
        <p className="max-w-md break-words px-2 text-sm leading-6 text-foreground">{description}</p>
      </div>
    </div>
  );
}
