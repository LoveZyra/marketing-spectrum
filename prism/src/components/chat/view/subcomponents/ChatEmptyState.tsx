import React from "react";
import { Trans, useTranslation } from "react-i18next";

import type { ProjectSession, LLMProvider } from "../../../../types/app";

import PromptStarterCards from "./PromptStarterCards";
import PrismVisionPanel from "./PrismVisionPanel";

const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

type ChatEmptyStateProps = {
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setInput: React.Dispatch<React.SetStateAction<string>>;
};

export default function ChatEmptyState({
  selectedSession,
  currentSessionId,
  provider,
  setInput,
}: ChatEmptyStateProps) {
  const { t } = useTranslation("chat");


  if (!selectedSession && !currentSessionId) {
    return (
      <div className="flex h-full items-center justify-center overflow-y-auto px-4 py-4">
        <div className="grid w-full max-w-full items-stretch gap-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          {/* Left column: the vision panel, with the search hint beneath it */}
          <div className="flex h-full flex-col gap-6">
            <div className="flex-1">
              <PrismVisionPanel />
            </div>

            <div className="w-full">
              <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground lg:justify-start">
                <Trans
                  ns="chat"
                  i18nKey="providerSelection.pressToSearch"
                  values={{ shortcut: MOD_KEY === "⌘" ? "⌘K" : "Ctrl+K" }}
                  components={{
                    kbd: (
                      <kbd className="inline-flex items-center gap-0.5 rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px]" />
                    ),
                  }}
                />
              </p>
            </div>
          </div>

          {/* Right column: starter examples, top-aligned */}
          <div className="w-full">
            {provider && (
              <div className="flex justify-center lg:justify-start">
                <PromptStarterCards onPick={(prompt) => setInput(prompt)} />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (selectedSession) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-[34.25rem] px-6 text-center">
          <p className="mb-1.5 text-lg font-semibold text-foreground">
            {t("session.continue.title")}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("session.continue.description")}
          </p>

        </div>
      </div>
    );
  }

  return null;
}
