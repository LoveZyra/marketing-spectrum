import React, { useCallback, useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
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
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  Card,
} from "../../../../shared/view/ui";

import PromptStarterCards from "./PromptStarterCards";
import PrismVisionPanel from "./PrismVisionPanel";

// The model picker below is still grouped by provider, because that is the
// shape `providerModelCatalog` comes back in — this list just has one entry now
// that OpenAI, Cursor and OpenCode are gone.
const PROVIDER_META: { id: LLMProvider; name: string }[] = [
  { id: "claude", name: "Anthropic" },
];

const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

// cmdk's default filter is fuzzy (loose character-subsequence scoring), which
// surfaces unrelated models — e.g. searching "chatgpt" also matched "Fable".
// Require every whitespace-separated search token to appear as a literal
// substring instead, so "claude 4.5" still matches "Anthropic Claude Haiku 4.5"
// but "chatgpt" only matches models that actually contain it.
function modelSearchFilter(value: string, search: string): number {
  const haystack = value.toLowerCase();
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((token) => haystack.includes(token)) ? 1 : 0;
}

type ProviderSelectionEmptyStateProps = {
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsLoading: boolean;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: React.Dispatch<React.SetStateAction<string>>;
};

type ProviderGroup = {
  id: LLMProvider;
  name: string;
  models: { value: string; label: string; description?: string }[];
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
  setClaudeModel,
  providerModelCatalog,
  providerModelsLoading,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
}: ProviderSelectionEmptyStateProps) {
  const { t } = useTranslation("chat");
  const [dialogOpen, setDialogOpen] = useState(false);

  const visibleProviderGroups = useMemo<ProviderGroup[]>(() => {
    return PROVIDER_META.map((p) => ({
      id: p.id,
      name: p.name,
      models: providerModelCatalog[p.id]?.OPTIONS ?? [],
    }));
  }, [providerModelCatalog]);

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

  // Selecting a model used to also select a provider — it wrote a
  // `selected-provider` localStorage key and then branched to one of four
  // model setters. There is one provider now, so this only stores the model.
  const handleModelSelect = useCallback(
    (modelValue: string) => {
      setClaudeModel(modelValue);
      localStorage.setItem("claude-model", modelValue);
      setDialogOpen(false);
      setTimeout(() => textareaRef.current?.focus(), 100);
    },
    [setClaudeModel, textareaRef],
  );

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

          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Card
                className="group mx-auto max-w-xs cursor-pointer border-border/60 transition-all duration-150 hover:border-border hover:shadow-md active:scale-[0.99] lg:mx-0"
                role="button"
                tabIndex={0}
              >
                <div className="flex items-center gap-2 p-3">
                  <ClaudeLogo className="h-5 w-5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-semibold text-foreground">
                        Claude
                      </span>
                      <span className="text-xs text-muted-foreground">·</span>
                      <span className="truncate text-xs text-foreground">
                        {currentModelLabel}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {t("providerSelection.clickToChange", {
                        defaultValue: "Click to change model",
                      })}
                    </p>
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-y-0.5" />
                </div>
              </Card>
            </DialogTrigger>

            <DialogContent className="max-w-md overflow-hidden p-0">
              <DialogTitle>Model Selector</DialogTitle>
              <div className="border-b border-border/60 bg-muted/20 px-4 py-3">
                <p className="text-sm font-semibold text-foreground">Choose a model</p>
              </div>
              <Command filter={modelSearchFilter}>
                <CommandInput
                  placeholder={t("providerSelection.searchModels", {
                    defaultValue: "Search models...",
                  })}
                />
                <CommandList className="max-h-[350px]">
                  <CommandEmpty>
                    {t("providerSelection.noModelsFound", {
                      defaultValue: "No models found.",
                    })}
                  </CommandEmpty>
                  {visibleProviderGroups.map((group, idx) => (
                    <CommandGroup
                      key={group.id}
                      className={
                        idx > 0
                          ? "border-t border-border/40 [&_[cmdk-group-heading]]:mt-1 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                          : "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                      }
                      heading={
                        <span className="flex items-center gap-1.5">
                          <ClaudeLogo className="h-3.5 w-3.5 shrink-0" />
                          {group.name}
                        </span>
                      }
                    >
                      {group.models.length === 0 && providerModelsLoading ? (
                        <CommandItem disabled className="ml-4 border-l border-border/40 pl-4 text-muted-foreground">
                          {t("providerSelection.loadingModels", { defaultValue: "Loading models…" })}
                        </CommandItem>
                      ) : null}
                      {group.models.map((model) => {
                        const isSelected = provider === group.id && currentModel === model.value;
                        return (
                          <CommandItem
                            key={`${group.id}-${model.value}`}
                            value={`${group.name} ${model.label} ${model.description || ''}`}
                            onSelect={() => handleModelSelect(model.value)}
                            className="ml-4 border-l border-border/40 pl-4"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate">{model.label}</div>
                              {/* 
                              // * Temporarly commented out because the description of models from claude 
                              // * was a bit inconsistent.  Will return it back when it becomes more consistent.
                              */}
                              {/* {model.description && (
                                <div className="truncate text-xs text-muted-foreground">
                                  {model.description}
                                </div>
                              )} */}
                            </div>
                            {isSelected && (
                              <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                            )}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  ))}
                </CommandList>
              </Command>
            </DialogContent>
          </Dialog>

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
