import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { PendingPermissionRequest } from '../../types/types';
import { buildClaudeToolPermissionEntry, formatToolInputForDisplay } from '../../utils/chatPermissions';
import { getClaudeSettings } from '../../utils/chatStorage';
import { getPermissionPanel, registerPermissionPanel } from '../../tools/configs/permissionPanelRegistry';
import { AskUserQuestionPanel } from '../../tools/components/InteractiveRenderers';
import {
  Confirmation,
  ConfirmationTitle,
  ConfirmationRequest,
  ConfirmationActions,
  ConfirmationAction,
} from '../../../../shared/view/ui';

registerPermissionPanel('AskUserQuestion', AskUserQuestionPanel);

interface PermissionRequestsBannerProps {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
}

export default function PermissionRequestsBanner({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
}: PermissionRequestsBannerProps) {
  const { t } = useTranslation('chat');
  // Filter out plan tool requests — they are handled inline by PlanDisplay
  const filteredRequests = pendingPermissionRequests.filter(
    (r) => r.toolName !== 'ExitPlanMode' && r.toolName !== 'exit_plan_mode'
  );

  if (!filteredRequests.length) {
    return null;
  }

  return (
    <div className="mb-3 space-y-2">
      {filteredRequests.map((request) => {
        const CustomPanel = getPermissionPanel(request.toolName);
        if (CustomPanel) {
          return (
            <CustomPanel
              key={request.requestId}
              request={request}
              onDecision={handlePermissionDecision}
            />
          );
        }

        const rawInput = formatToolInputForDisplay(request.input);
        const permissionEntry = buildClaudeToolPermissionEntry(request.toolName, rawInput);
        const settings = getClaudeSettings();
        const alreadyAllowed = permissionEntry ? settings.allowedTools.includes(permissionEntry) : false;
        const rememberLabel = alreadyAllowed
          ? t('permission.allowSaved', { defaultValue: '已记住' })
          : t('permission.allowRemember', { defaultValue: '允许并记住' });
        const matchingRequestIds = permissionEntry
          ? pendingPermissionRequests
              .filter(
                (item) =>
                  buildClaudeToolPermissionEntry(item.toolName, formatToolInputForDisplay(item.input)) === permissionEntry,
              )
              .map((item) => item.requestId)
          : [request.requestId];

        return (
          <Confirmation key={request.requestId} approval="pending">
            <ConfirmationTitle className="flex items-start gap-2.5">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" strokeWidth={2} />
              <ConfirmationRequest>
                <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
                  <span className="text-[13.5px] font-semibold leading-5 text-card-foreground">
                    {t('permission.title', { defaultValue: '需要授权才能继续' })}
                  </span>
                  {/* 工具名 + 规则合成一行等宽元信息 —— 整行已是等宽,不再套芯片底色 */}
                  <span className="font-mono text-[11.5px] leading-[17px] text-muted-foreground">
                    {t('permission.meta', {
                      defaultValue: '工具 {{tool}}{{rule}}',
                      tool: request.toolName,
                      rule: permissionEntry ? ` · 规则 ${permissionEntry}` : '',
                    })}
                  </span>
                  {rawInput && (
                    <details>
                      <summary className="cursor-pointer text-xs leading-[18px] text-muted-foreground hover:text-foreground">
                        {t('permission.viewInput', { defaultValue: '查看工具输入' })}
                      </summary>
                      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-2 font-mono text-xs text-muted-foreground">
                        {rawInput}
                      </pre>
                    </details>
                  )}
                </div>
              </ConfirmationRequest>
            </ConfirmationTitle>

            <ConfirmationActions>
              <ConfirmationAction
                variant="ghost"
                onClick={() => handlePermissionDecision(request.requestId, { allow: false, message: 'User denied tool use' })}
              >
                {t('permission.deny', { defaultValue: '拒绝' })}
              </ConfirmationAction>
              <ConfirmationAction
                variant="outline"
                onClick={() => {
                  if (permissionEntry && !alreadyAllowed) {
                    handleGrantToolPermission({ entry: permissionEntry, toolName: request.toolName });
                  }
                  handlePermissionDecision(matchingRequestIds, { allow: true, rememberEntry: permissionEntry });
                }}
                disabled={!permissionEntry}
              >
                {rememberLabel}
              </ConfirmationAction>
              <ConfirmationAction
                variant="default"
                onClick={() => handlePermissionDecision(request.requestId, { allow: true })}
              >
                {t('permission.allowOnce', { defaultValue: '允许一次' })}
              </ConfirmationAction>
            </ConfirmationActions>
          </Confirmation>
        );
      })}
    </div>
  );
}
