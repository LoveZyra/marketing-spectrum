

import { useTranslation } from 'react-i18next';
import { Languages } from 'lucide-react';

import { setLanguagePreference } from '../../../i18n/config.js';
import { languages } from '../../../i18n/languages';

type LanguageSelectorProps = {
  compact?: boolean;
};

/**
 * Dropdown for the interface language. A pick switches i18next and is recorded
 * as the user's explicit choice (see `setLanguagePreference`).
 *
 * @param {boolean} compact - Compact style for the quick settings panel (default: false)
 */
export default function LanguageSelector({ compact = false }: LanguageSelectorProps) {
  const { i18n, t } = useTranslation('settings');

  const handleLanguageChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    // Not `i18n.changeLanguage` directly: this records the pick as deliberate,
    // which is what keeps it from being overwritten the next time the app's
    // default language moves.
    void setLanguagePreference(event.target.value);
  };

  // Compact style for the quick settings panel
  if (compact) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-transparent bg-card p-3 transition-colors hover:border-border">
        {/* defaultValue 兜底:当前语种缺这个键、英文回退又还没挂上时,
            i18next 会把键名原样打出来(界面上就是「account.language」)。 */}
        <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
          <Languages className="h-4 w-4 flex-none text-muted-foreground" />
          <span className="min-w-0 truncate">{t('account.language', { defaultValue: '语言' })}</span>
        </span>
        <select
          value={i18n.language}
          onChange={handleLanguageChange}
          className="w-auto min-w-[110px] max-w-[150px] flex-none rounded-lg border border-input bg-card p-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {languages.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.nativeName}
            </option>
          ))}
        </select>
      </div>
    );
  }

  // Full style for Settings page
  return (
    <div className="flex items-center justify-between px-4 py-3.5">
      <div>
        <div className="text-sm font-medium text-foreground">
          {t('account.languageLabel', { defaultValue: '语言选择' })}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {t('account.languageDescription', { defaultValue: '界面显示用哪种语言' })}
        </div>
      </div>
      <select
        value={i18n.language}
        onChange={handleLanguageChange}
        className="w-36 rounded-lg border border-input bg-card p-2 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary"
      >
        {languages.map((lang) => (
          <option key={lang.value} value={lang.value}>
            {lang.nativeName}
          </option>
        ))}
      </select>
    </div>
  );
}
