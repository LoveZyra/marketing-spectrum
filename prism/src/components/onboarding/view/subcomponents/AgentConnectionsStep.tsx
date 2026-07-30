import type { LLMProvider } from '../../../../types/app';
import type { ProviderAuthStatusMap } from '../../../provider-auth/types';

import AgentConnectionCard from './AgentConnectionCard';

type AgentConnectionsStepProps = {
  providerStatuses: ProviderAuthStatusMap;
  onOpenProviderLogin: (provider: LLMProvider) => void;
};

/**
 * The "connect your agents" onboarding step.
 *
 * This used to map over a four-entry `providerCards` list — Claude, Cursor,
 * OpenAI Codex and OpenCode — each carrying its own palette so the cards read
 * blue, purple, grey and zinc. Claude is the only agent this build talks to, so
 * the list is a single card and its palette is inlined at the call site.
 */
export default function AgentConnectionsStep({
  providerStatuses,
  onOpenProviderLogin,
}: AgentConnectionsStepProps) {
  return (
    <div className="space-y-4">
      <div className="text-center">
        <h2 className="font-serif text-xl font-bold tracking-tight text-foreground">Connect Claude Code</h2>
        <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
          Login to the Claude Code CLI. This is optional — you can do it later.
        </p>
      </div>

      <div className="-mr-1 max-h-[38vh] space-y-2 overflow-y-auto pr-1">
        <AgentConnectionCard
          title="Claude Code"
          status={providerStatuses.claude}
          connectedClassName="bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800"
          iconContainerClassName="bg-blue-100 dark:bg-blue-900/30"
          loginButtonClassName="bg-blue-600 hover:bg-blue-700"
          onLogin={() => onOpenProviderLogin('claude')}
        />
      </div>

      <p className="text-center text-xs text-muted-foreground">You can configure this later in Settings.</p>
    </div>
  );
}
