import { X } from 'lucide-react';

import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import { DEFAULT_PROJECT_FOR_EMPTY_SHELL } from '../../../constants/config';

type ProviderLoginModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onComplete?: (exitCode: number) => void;
  customCommand?: string;
};

// Claude is the only CLI Prism drives, so the login command and modal title are
// constants; the command is the same whether or not Prism runs hosted.
const CLAUDE_LOGIN_COMMAND = 'claude --dangerously-skip-permissions /login';
const CLAUDE_LOGIN_TITLE = 'Claude CLI Login';

export default function ProviderLoginModal({
  isOpen,
  onClose,
  onComplete,
  customCommand,
}: ProviderLoginModalProps) {
  if (!isOpen) {
    return null;
  }

  const command = customCommand || CLAUDE_LOGIN_COMMAND;
  const title = CLAUDE_LOGIN_TITLE;

  const handleComplete = (exitCode: number) => {
    onComplete?.(exitCode);
    // Keep the modal open so users can read terminal output before closing.
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background bg-opacity-50 max-md:items-stretch max-md:justify-stretch">
      <div className="prism-modal-shadow flex h-3/4 w-full max-w-4xl flex-col rounded-lg bg-background max-md:m-0 max-md:h-full max-md:max-w-none max-md:rounded-none md:m-4 md:h-3/4 md:max-w-4xl md:rounded-lg">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h3 className="text-lg font-semibold text-foreground">{title}</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-body"
            aria-label="Close login modal"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden">
          <StandaloneShell project={DEFAULT_PROJECT_FOR_EMPTY_SHELL} command={command} onComplete={handleComplete} minimal={true} />
        </div>
      </div>
    </div>
  );
}
