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

/**
 * 首页空态 —— 左边品牌区,右边四张起手卡,输入框在页面底部。
 *
 * ## 这一版是还原回来的
 *
 * ef 曾把它改成「一行问候 → 内嵌输入框 → 4 张半高起手卡 → 工具 → 最近会话 3 条」,
 * 理由写得很清楚:每开一个新会话都要再看一遍登录页讲过的口号,而"最近在做什么"
 * 反倒找不到。**ex 按用户要求整体还原回 ef 之前这一版。**
 *
 * 记下来是因为这不是"改错了又改回来":两版各有各的道理 —— 高频使用者嫌口号啰嗦,
 * 而把 Prism 打开给别人看的时候,品牌区恰恰是要讲的东西。哪一版对取决于这个产品
 * 当下更在意谁。所以两版的实现都别删干净:ef 那版完整躺在 `prism-20260904ew.tar.gz`
 * 里,要换回去照着 CHANGELOG 的 ef 条目取。
 *
 * 跟着一起撤掉的:`composerSlot`(输入框内嵌)、`recentSessions`(最近会话)、
 * `HomeToolsSection`(独立的「工具」栏目 —— 外部应用回到第四张起手卡里,
 * 但地址仍读 `config/externalApps.ts`,没有跟着还原成写死路径)。
 */
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
          {/* 左栏:品牌区,下面挂搜索提示 */}
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

          {/* 右栏:起手卡,顶对齐 */}
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
