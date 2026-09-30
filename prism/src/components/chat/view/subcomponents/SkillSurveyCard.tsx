import { useState } from 'react';
import { Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useToast } from '../../../../shared/view/ui';
import type { FeedbackPayload, FeedbackVerdict } from '../../hooks/useMessageFeedback';

/**
 * gy:「这次「<skill>」处理得怎么样?」—— 调过 skill 的回合结束后,按抽样弹给发起人的
 * **主动**反馈入口。不是弹窗:产出卡同一位置的行内卡。
 *
 * 该不该出现由服务端算(work-frames 的 `skillSurveys`),这里只画:选一档即落库(文本框
 * 此时才展开,填了再提交一次更新同一行);「跳过」记一条 dismissed,同样不再弹。
 */
export type SkillSurveyCardProps = {
  messageId: string;
  skill: string;
  onSubmit: (messageId: string, payload: FeedbackPayload) => Promise<unknown>;
};

export default function SkillSurveyCard({ messageId, skill, onSubmit }: SkillSurveyCardProps) {
  const { t } = useTranslation('chat');
  const { toast } = useToast();
  const [verdict, setVerdict] = useState<FeedbackVerdict | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'answered' | 'dismissed' | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      return true;
    } catch (error) {
      toast({ message: t('feedback.failed', { defaultValue: '反馈没有保存成功' }), description: error instanceof Error ? error.message : undefined, variant: 'error' });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const pick = (value: FeedbackVerdict) => run(async () => {
    await onSubmit(messageId, { source: 'survey', verdict: value, skillHint: skill });
    setVerdict(value);
  });

  const submitNote = () => run(async () => {
    if (verdict === null) return;
    await onSubmit(messageId, { source: 'survey', verdict, note: note.trim() || null, skillHint: skill });
    setDone('answered');
  });

  const skip = () => run(async () => {
    await onSubmit(messageId, { source: 'survey', status: 'dismissed', skillHint: skill });
    setDone('dismissed');
  });

  if (done) {
    return (
      <div data-skill-survey className="rounded-panel border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        {done === 'answered'
          ? t('survey.thanks', { defaultValue: '谢谢,已记下 —— 这会成为这个技能下次优化的依据。' })
          : t('survey.skipped', { defaultValue: '好的,这次不问了。' })}
      </div>
    );
  }

  const optionClass = (active: boolean) =>
    `inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[13px] transition-colors ${active ? 'border-primary bg-accent text-accent-foreground' : 'border-border bg-card text-foreground hover:border-border-strong'}`;

  return (
    <div data-skill-survey className="rounded-panel border border-border-strong bg-card p-3.5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-accent text-accent-foreground">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
        </span>
        <div className="text-[14px] text-foreground">
          {t('survey.question', { defaultValue: '这次「{{skill}}」处理得怎么样?', skill })}
        </div>
        <div className="flex-1" />
        <button type="button" onClick={skip} disabled={busy} className="h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          {t('survey.skip', { defaultValue: '跳过' })}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => pick(1)} disabled={busy} aria-pressed={verdict === 1} className={optionClass(verdict === 1)}>
          <ThumbsUp className="h-3.5 w-3.5" aria-hidden /> {t('survey.good', { defaultValue: '好' })}
        </button>
        <button type="button" onClick={() => pick(0)} disabled={busy} aria-pressed={verdict === 0} className={optionClass(verdict === 0)}>
          {t('survey.neutral', { defaultValue: '一般' })}
        </button>
        <button type="button" onClick={() => pick(-1)} disabled={busy} aria-pressed={verdict === -1} className={optionClass(verdict === -1)}>
          <ThumbsDown className="h-3.5 w-3.5" aria-hidden /> {t('survey.bad', { defaultValue: '差' })}
        </button>
        <span className="text-xs text-muted-foreground">
          {verdict === null
            ? t('survey.hintPick', { defaultValue: '选一档即记录;想多说两句再填下面' })
            : t('survey.hintRecorded', { defaultValue: '已记录。可以补一句待优化点,或直接关掉' })}
        </span>
      </div>
      {verdict !== null && (
        <div className="mt-3 flex flex-col gap-2">
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            maxLength={2000}
            placeholder={t('survey.notePlaceholder', { defaultValue: '待优化点(可不填)。例:漏了渠道口径 / 表格少一列 / 该先问我时间窗' })}
            className="resize-none rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground focus:border-primary focus:outline-none"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              {t('survey.footnote', { defaultValue: '调过技能的回合按抽样询问;同一技能一小时内不再问;可在「我的账号」关闭' })}
            </span>
            <div className="flex gap-2">
              <button type="button" onClick={() => setDone('answered')} disabled={busy} className="h-7 rounded-md border border-border px-2.5 text-xs text-foreground hover:border-border-strong">
                {t('survey.close', { defaultValue: '就这样' })}
              </button>
              <button type="button" onClick={submitNote} disabled={busy || !note.trim()} className="prism-action h-7 rounded-md border px-3 text-xs disabled:opacity-50">
                {t('survey.submit', { defaultValue: '提交' })}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
