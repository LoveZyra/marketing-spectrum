import React, { useMemo } from "react";
import { Trans, useTranslation } from "react-i18next";

import type {
  ProjectSession,
  LLMProvider,
  ProviderModelsDefinition,
} from "../../../../types/app";
import ClaudeLogo from "../../../llm-logo-provider/ClaudeLogo";
// Imported by concrete path, not through `../../../task-master`. This file is
// on the eager path (ChatInterface renders it), and the barrel also re-exports
// TaskMasterPanel — which reaches the PRD editor and so all of CodeMirror.
// Going through the barrel pulled ~660 kB of editor into the entry chunk.
import NextTaskBanner from "../../../task-master/view/NextTaskBanner";
import { Card } from "../../../../shared/view/ui";

import PromptStarterCards from "./PromptStarterCards";
import PrismVisionPanel from "./PrismVisionPanel";

const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

type ProviderSelectionEmptyStateProps = {
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: React.Dispatch<React.SetStateAction<string>>;
};

function getModelConfig(
  p: LLMProvider,
  catalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>,
): ProviderModelsDefinition {
  const entry = catalog[p];
  return entry ?? { OPTIONS: [], DEFAULT: "" };
}

// `getCurrentModel` and `getProviderDisplayName` used to dispatch over the
// provider to pick one of four model states and one of four display names.
// Both had a single reachable branch once the other three agents were removed.

export default function ProviderSelectionEmptyState({
  selectedSession,
  currentSessionId,
  provider,
  textareaRef,
  claudeModel,
  providerModelCatalog,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
}: ProviderSelectionEmptyStateProps) {
  const { t } = useTranslation("chat");

  const nextTaskPrompt = t("tasks.nextTaskPrompt", {
    defaultValue: "Start the next task",
  });

  const currentModel = claudeModel;

  const currentModelLabel = useMemo(() => {
    const config = getModelConfig(provider, providerModelCatalog);
    const found = config.OPTIONS.find(
      (o: { value: string; label: string }) => o.value === currentModel,
    );
    return found?.label || currentModel;
  }, [provider, currentModel, providerModelCatalog]);

  if (!selectedSession && !currentSessionId) {
    return (
      <div className="flex h-full items-center justify-center overflow-y-auto px-4 py-4">
        <div className="grid w-full max-w-full items-stretch gap-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          {/* Left column: vision fills the height, AI-assistant selector sits beneath it */}
          <div className="flex h-full flex-col gap-6">
            <div className="flex-1">
              <PrismVisionPanel />
            </div>

            <div className="w-full">
          <div className="mb-4 text-center lg:text-left">
            <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              {t("providerSelection.title")}
            </h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {t("providerSelection.description")}
            </p>
          </div>

          {/* Read-only. Model switching lives in the /models command now, so
              there is exactly one control instead of two that wrote to
              different places — this card set a client-side default while
              /models set a session-scoped override, and whichever ran last
              silently won. */}
          <Card className="mx-auto max-w-xs border-border/60 lg:mx-0">
            <div className="flex items-center gap-2 p-3">
              <ClaudeLogo className="h-5 w-5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span className="text-xs font-semibold text-foreground">Claude</span>
                  <span className="text-xs text-muted-foreground">·</span>
                  <span className="truncate text-xs text-foreground">{currentModelLabel}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {t("providerSelection.useModelsCommand", {
                    defaultValue: "输入 /models 切换模型",
                  })}
                </p>
              </div>
            </div>
          </Card>

          <p className="mt-4 text-center text-sm text-muted-foreground/70 lg:text-left">
            {t("providerSelection.readyPrompt.claude", { model: claudeModel })}
          </p>

          <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground/60 lg:justify-start">
            <Trans
              ns="chat"
              i18nKey="providerSelection.pressToSearch"
              values={{ shortcut: MOD_KEY === "⌘" ? "⌘K" : "Ctrl+K" }}
              components={{
                kbd: (
                  <kbd className="inline-flex items-center gap-0.5 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]" />
                ),
              }}
            />
          </p>
            </div>
          </div>

          {/* Right column: starter examples, top-aligned */}
          <div className="w-full">
            {provider && tasksEnabled && isTaskMasterInstalled && (
              <div className="mb-5">
                <NextTaskBanner
                  onStartTask={() => setInput(nextTaskPrompt)}
                  onShowAllTasks={onShowAllTasks}
                />
              </div>
            )}

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

          {tasksEnabled && isTaskMasterInstalled && (
            <div className="mt-5">
              <NextTaskBanner
                onStartTask={() => setInput(nextTaskPrompt)}
                onShowAllTasks={onShowAllTasks}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
