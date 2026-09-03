import React from "react";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ProjectSession, LLMProvider } from "../../../../types/app";
import { useAuth } from "../../../auth/context/AuthContext";
import { formatRelativeTime } from "../../../file-tree/utils/fileTreeUtils";
import { greetingKey, type RecentSessionEntry } from "../../utils/recentSessions";

import PromptStarterCards from "./PromptStarterCards";
import HomeToolsSection from "./HomeToolsSection";

type ChatEmptyStateProps = {
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  /** ef:首页空态里输入框嵌在问候语下面,由 ChatInterface 把同一个 ChatComposer 传进来。 */
  composerSlot?: React.ReactNode;
  recentSessions?: RecentSessionEntry[];
  onOpenSession?: (sessionId: string) => void;
};

/**
 * 首页空态(ef 重做)。
 *
 * 之前是"品牌口号卡 + 四张两行起手卡"铺满主区 —— 每开一个新会话都要再看一遍
 * 登录页讲过的口号,反而找不到"最近在做什么"。现在从上到下:一行问候 → 输入框
 * (进来就能打字)→ 4 张半高起手卡(标题 + 一句话)→ 工具(外部应用)→ 最近会话 3 条。
 * 点阵画布只留在这一页(ChatMessagesPane 的 .prism-canvas)。
 */
export default function ChatEmptyState({
  selectedSession,
  currentSessionId,
  provider,
  setInput,
  composerSlot,
  recentSessions,
  onOpenSession,
}: ChatEmptyStateProps) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const { user } = useAuth();

  if (!selectedSession && !currentSessionId) {
    const greeting = t(`home.greeting.${greetingKey(new Date().getHours())}`, {
      defaultValue: "你好",
    });
    const username = user?.username ? String(user.username) : "";
    const recents = recentSessions ?? [];

    return (
      <div data-home-empty className="mx-auto flex w-full max-w-[45rem] flex-col gap-7 px-4">
        <div className="flex flex-col gap-1.5">
          <p className="text-[22px] font-medium leading-[30px] text-foreground">
            {username
              ? t("home.greetingWithName", { defaultValue: "{{greeting}}，{{name}}", greeting, name: username })
              : greeting}
          </p>
          <p className="text-[13px] leading-5 text-muted-foreground">
            {t("home.subtitle", { defaultValue: "从一个问题开始,或者接着上次的工作。" })}
          </p>
        </div>

        {/* 输入框:ChatComposer 自带外壳内边距(px-2/4 + pb),这里用负边距抵掉,
            让它与问候、卡片、最近会话对齐到同一条边。 */}
        {composerSlot && (
          <div data-home-composer className="-mx-2 -mb-2 sm:-mx-4 sm:-mb-4 md:-mb-6">
            {composerSlot}
          </div>
        )}

        {provider && <PromptStarterCards onPick={(prompt) => setInput(prompt)} />}

        {/* ek:挂在 Prism 上的外部应用(算法效果查询)。原先它挤在第四张起手卡的
            右下角 —— 起手卡是"填输入框",它是"跳走",两种行为不该长成一个样子。 */}
        <HomeToolsSection />

        {recents.length > 0 && (
          <div data-home-recent className="flex flex-col gap-2.5">
            <p className="text-[11px] font-medium uppercase tracking-[1.4px] text-muted-foreground">
              {t("home.recentSessions", { defaultValue: "最近会话" })}
            </p>
            <div className="overflow-hidden rounded-panel border border-border bg-card">
              {recents.map((entry, index) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => onOpenSession?.(entry.id)}
                  className={`group flex h-10 w-full items-center gap-2.5 px-3 text-left transition-colors hover:bg-muted ${
                    index > 0 ? "border-t border-border" : ""
                  }`}
                >
                  {/* 设计稿:行首一枚状态点(实心 = 在跑,空心 = 等授权),没有就留空位对齐 */}
                  {entry.status ? (
                    <span
                      className={`h-1.5 w-1.5 flex-none rounded-full ${entry.status === 'approval' ? 'border-[1.5px] border-primary' : 'prism-dot bg-primary'}`}
                      aria-hidden
                    />
                  ) : (
                    <span className="h-1.5 w-1.5 flex-none" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{entry.title}</span>
                  <span className="max-w-40 flex-none truncate text-xs text-muted-foreground">{entry.projectName}</span>
                  <span className="w-16 flex-none text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                    {entry.time ? formatRelativeTime(entry.time, tCommon) : ""}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 flex-none text-border-strong transition-colors group-hover:text-foreground" aria-hidden />
                </button>
              ))}
            </div>
          </div>
        )}
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
