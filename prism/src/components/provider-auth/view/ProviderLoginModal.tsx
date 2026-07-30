import { X } from 'lucide-react';

import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import { DEFAULT_PROJECT_FOR_EMPTY_SHELL } from '../../../constants/config';

type ProviderLoginModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onComplete?: (exitCode: number) => void;
  customCommand?: string;
};

// This pair used to dispatch over the provider to pick a login command
// (`cursor-agent login`, `codex login`, `opencode auth login`) and a modal
// title. Claude is the only CLI this build drives, so both are constants.
//
// Note that Codex was the only branch that read `IS_PLATFORM` here — it swapped
// in `--device-auth` when running hosted. Claude's login command is the same
// either way, so that flag is no longer consulted in this file.
const CLAUDE_LOGIN_COMMAND = 'claude --dangerously-skip-permissions /login';
const CLAUDE_LOGIN_TITLE = 'Claude CLI Login';

// `provider` and `isAuthenticated` used to be props here. `provider` picked the
// login command; `isAuthenticated` was already destructured as `_isAuthenticated`
// and never read, so it did nothing before this change either.
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
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-50 max-md:items-stretch max-md:justify-stretch">
      <div className="flex h-3/4 w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl dark:bg-gray-800 max-md:m-0 max-md:h-full max-md:max-w-none max-md:rounded-none md:m-4 md:h-3/4 md:max-w-4xl md:rounded-lg">
        <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300"
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
