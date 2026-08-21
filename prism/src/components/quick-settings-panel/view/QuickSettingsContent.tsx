import { useTranslation } from 'react-i18next';

import LanguageSelector from '../../../shared/view/ui/LanguageSelector';
import { INPUT_SETTING_TOGGLES, TOOL_DISPLAY_TOGGLES } from '../constants';
import type {
  PreferenceToggleItem,
  PreferenceToggleKey,
  QuickSettingsPreferences,
} from '../types';

import QuickSettingsSection from './QuickSettingsSection';
import QuickThemeSwitch from './QuickThemeSwitch';
import QuickSettingsToggleRow from './QuickSettingsToggleRow';

type QuickSettingsContentProps = {
  preferences: QuickSettingsPreferences;
  onPreferenceChange: (key: PreferenceToggleKey, value: boolean) => void;
};

export default function QuickSettingsContent({
  preferences,
  onPreferenceChange,
}: QuickSettingsContentProps) {
  const { t } = useTranslation('settings');
  const inputSettingToggles = INPUT_SETTING_TOGGLES;

  const renderToggleRows = (items: PreferenceToggleItem[]) => (
    items.map(({ key, labelKey, icon }) => (
      <QuickSettingsToggleRow
        key={key}
        label={t(labelKey)}
        icon={icon}
        checked={preferences[key]}
        onCheckedChange={(value) => onPreferenceChange(key, value)}
      />
    ))
  );

  return (
    <div className="flex-1 space-y-6 overflow-y-auto overflow-x-hidden bg-background p-4">
      <QuickSettingsSection title={t('quickSettings.sections.appearance')}>
        {/* 原来是一枚「深色模式」开关。浅色分成两种材质之后布尔表达不了三个值。 */}
        <QuickThemeSwitch />
        <LanguageSelector compact />
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.toolDisplay')}>
        {renderToggleRows(TOOL_DISPLAY_TOGGLES)}
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.inputSettings')}>
        {renderToggleRows(inputSettingToggles)}
        <p className="ml-3 text-xs text-muted-foreground">
          {t('quickSettings.sendByCtrlEnterDescription')}
        </p>
      </QuickSettingsSection>
    </div>
  );
}
