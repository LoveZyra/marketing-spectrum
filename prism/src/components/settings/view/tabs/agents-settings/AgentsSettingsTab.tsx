import { useState } from 'react';

import type { AgentCategory } from '../../../types/types';

import type { AgentsSettingsTabProps } from './types';
import AgentCategoryContentSection from './sections/AgentCategoryContentSection';
import AgentCategoryTabsSection from './sections/AgentCategoryTabsSection';

const CATEGORIES: AgentCategory[] = ['account', 'permissions', 'mcp', 'skills'];

export default function AgentsSettingsTab({
  authStatus,
  onLogin,
  claudePermissions,
  onClaudePermissionsChange,
  projects,
}: AgentsSettingsTabProps) {
  const [selectedCategory, setSelectedCategory] = useState<AgentCategory>('account');

  return (
    <div className="-mx-4 -mb-4 -mt-2 flex min-h-[300px] min-w-0 flex-col overflow-hidden md:-mx-6 md:-mb-6 md:-mt-2 md:min-h-[500px]">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AgentCategoryTabsSection
          categories={CATEGORIES}
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
        />

        <AgentCategoryContentSection
          selectedCategory={selectedCategory}
          authStatus={authStatus}
          onLogin={onLogin}
          claudePermissions={claudePermissions}
          onClaudePermissionsChange={onClaudePermissionsChange}
          projects={projects}
        />
      </div>
    </div>
  );
}
