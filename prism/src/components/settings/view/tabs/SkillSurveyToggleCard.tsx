import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useUiPreferences } from '../../../../hooks/useUiPreferences';
import { useSkillWhetEnabled } from '../../../skillwhet/hooks/useSkillWhetStatus';

/**
 * 「技能效果询问」开关:关掉之后,调过技能的回合结束时不再弹调查卡。
 *
 * 存在账号同步的 `uiPreferences.skillSurveyEnabled`(与紧凑模式等同一张表),服务端
 * 算 work-frames 的 `skillSurveys` 时读同一个键,所以换设备也生效。技能优化没挂载时
 * 整卡不画:开关没对象就别摆出来让人猜。
 */
export default function SkillSurveyToggleCard() {
  const { t } = useTranslation('settings');
  const enabled = useSkillWhetEnabled();
  const { preferences, setPreference } = useUiPreferences();
  if (!enabled) return null;
  const on = preferences.skillSurveyEnabled !== false;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-4" data-testid="skill-survey-toggle">
      <span className="bg-primary/8 grid h-9 w-9 shrink-0 place-items-center rounded-full text-primary"><Sparkles className="h-4 w-4" aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{t('account.skillSurvey.title', '技能效果询问')}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('account.skillSurvey.help', '调过技能的回合结束后,按抽样在回答下方问一句「这次处理得怎么样」。你的答复与所有人的一起,只用于优化这个技能本身。')}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={t('account.skillSurvey.title', '技能效果询问')}
        onClick={() => setPreference('skillSurveyEnabled', !on)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? 'bg-primary' : 'bg-border-strong/50'}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
    </div>
  );
}
