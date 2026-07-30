import { useState } from 'react';
import { AlertTriangle, Plus, Shield, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../../../../../../shared/view/ui';

const COMMON_CLAUDE_TOOLS = [
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Write',
  'Read',
  'Edit',
  'Glob',
  'Grep',
  'MultiEdit',
  'Task',
  'TodoWrite',
  'TodoRead',
  'WebFetch',
  'WebSearch',
];

const addUnique = (items: string[], value: string): string[] => {
  const normalizedValue = value.trim();
  if (!normalizedValue || items.includes(normalizedValue)) {
    return items;
  }

  return [...items, normalizedValue];
};

const removeValue = (items: string[], value: string): string[] => (
  items.filter((item) => item !== value)
);

type PermissionsContentProps = {
  skipPermissions: boolean;
  onSkipPermissionsChange: (value: boolean) => void;
  allowedTools: string[];
  onAllowedToolsChange: (value: string[]) => void;
  disallowedTools: string[];
  onDisallowedToolsChange: (value: string[]) => void;
};

/**
 * Claude's tool allow/deny lists.
 *
 * Three permission models used to share this file behind an `agent`
 * discriminant, and the default export was a switch over it: Claude's tool
 * lists, Cursor's shell-command lists, and Codex's three-way permission-mode
 * radio. Two of the three agents are gone, so the discriminant had one value
 * and the switch one arm — this component is the whole file now.
 */
export default function PermissionsContent({
  skipPermissions,
  onSkipPermissionsChange,
  allowedTools,
  onAllowedToolsChange,
  disallowedTools,
  onDisallowedToolsChange,
}: PermissionsContentProps) {
  const { t } = useTranslation('settings');
  const [newAllowedTool, setNewAllowedTool] = useState('');
  const [newDisallowedTool, setNewDisallowedTool] = useState('');

  const handleAddAllowedTool = (tool: string) => {
    const updated = addUnique(allowedTools, tool);
    if (updated.length === allowedTools.length) {
      return;
    }

    onAllowedToolsChange(updated);
    setNewAllowedTool('');
  };

  const handleAddDisallowedTool = (tool: string) => {
    const updated = addUnique(disallowedTools, tool);
    if (updated.length === disallowedTools.length) {
      return;
    }

    onDisallowedToolsChange(updated);
    setNewDisallowedTool('');
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-orange-500" />
          <h3 className="text-lg font-medium text-foreground">{t('permissions.title')}</h3>
        </div>
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-4 dark:border-orange-800 dark:bg-orange-900/20">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={skipPermissions}
              onChange={(event) => onSkipPermissionsChange(event.target.checked)}
              className="h-4 w-4 rounded border-input bg-card text-primary focus:ring-2 focus:ring-primary"
            />
            <div>
              <div className="font-medium text-orange-900 dark:text-orange-100">
                {t('permissions.skipPermissions.label')}
              </div>
              <div className="text-sm text-orange-700 dark:text-orange-300">
                {t('permissions.skipPermissions.claudeDescription')}
              </div>
            </div>
          </label>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Shield className="h-5 w-5 text-green-500" />
          <h3 className="text-lg font-medium text-foreground">{t('permissions.allowedTools.title')}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{t('permissions.allowedTools.description')}</p>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={newAllowedTool}
            onChange={(event) => setNewAllowedTool(event.target.value)}
            placeholder={t('permissions.allowedTools.placeholder')}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleAddAllowedTool(newAllowedTool);
              }
            }}
            className="h-10 flex-1"
          />
          <Button
            onClick={() => handleAddAllowedTool(newAllowedTool)}
            disabled={!newAllowedTool.trim()}
            size="sm"
            className="h-10 px-4"
          >
            <Plus className="mr-2 h-4 w-4 sm:mr-0" />
            <span className="sm:hidden">{t('permissions.actions.add')}</span>
          </Button>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">
            {t('permissions.allowedTools.quickAdd')}
          </p>
          <div className="flex flex-wrap gap-2">
            {COMMON_CLAUDE_TOOLS.map((tool) => (
              <Button
                key={tool}
                variant="outline"
                size="sm"
                onClick={() => handleAddAllowedTool(tool)}
                disabled={allowedTools.includes(tool)}
                className="h-8 text-xs"
              >
                {tool}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          {allowedTools.map((tool) => (
            <div key={tool} className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-900/20">
              <span className="font-mono text-sm text-green-800 dark:text-green-200">{tool}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onAllowedToolsChange(removeValue(allowedTools, tool))}
                className="text-green-600 hover:text-green-700"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {allowedTools.length === 0 && (
            <div className="py-6 text-center text-muted-foreground">
              {t('permissions.allowedTools.empty')}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-red-500" />
          <h3 className="text-lg font-medium text-foreground">{t('permissions.blockedTools.title')}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{t('permissions.blockedTools.description')}</p>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={newDisallowedTool}
            onChange={(event) => setNewDisallowedTool(event.target.value)}
            placeholder={t('permissions.blockedTools.placeholder')}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleAddDisallowedTool(newDisallowedTool);
              }
            }}
            className="h-10 flex-1"
          />
          <Button
            onClick={() => handleAddDisallowedTool(newDisallowedTool)}
            disabled={!newDisallowedTool.trim()}
            size="sm"
            className="h-10 px-4"
          >
            <Plus className="mr-2 h-4 w-4 sm:mr-0" />
            <span className="sm:hidden">{t('permissions.actions.add')}</span>
          </Button>
        </div>

        <div className="space-y-2">
          {disallowedTools.map((tool) => (
            <div key={tool} className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20">
              <span className="font-mono text-sm text-red-800 dark:text-red-200">{tool}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDisallowedToolsChange(removeValue(disallowedTools, tool))}
                className="text-red-600 hover:text-red-700"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {disallowedTools.length === 0 && (
            <div className="py-6 text-center text-muted-foreground">
              {t('permissions.blockedTools.empty')}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20">
        <h4 className="mb-2 font-medium text-blue-900 dark:text-blue-100">
          {t('permissions.toolExamples.title')}
        </h4>
        <ul className="space-y-1 text-sm text-blue-800 dark:text-blue-200">
          <li><code className="rounded bg-blue-100 px-1 dark:bg-blue-800">"Bash(git log:*)"</code> {t('permissions.toolExamples.bashGitLog')}</li>
          <li><code className="rounded bg-blue-100 px-1 dark:bg-blue-800">"Bash(git diff:*)"</code> {t('permissions.toolExamples.bashGitDiff')}</li>
          <li><code className="rounded bg-blue-100 px-1 dark:bg-blue-800">"Write"</code> {t('permissions.toolExamples.write')}</li>
          <li><code className="rounded bg-blue-100 px-1 dark:bg-blue-800">"Bash(rm:*)"</code> {t('permissions.toolExamples.bashRm')}</li>
        </ul>
      </div>

    </div>
  );
}
