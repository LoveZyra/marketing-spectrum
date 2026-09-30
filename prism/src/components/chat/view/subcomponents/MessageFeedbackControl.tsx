import { useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useToast } from '../../../../shared/view/ui';
import type { FeedbackCategory, FeedbackPayload, MessageFeedbackRow } from '../../hooks/useMessageFeedback';

/**
 * gy:回答下方的 👍/👎 —— 技能优化的**被动**数据入口。
 *
 * 与复制按钮同一行、同一种 24×24 幽灵图标钮;👎 就地展开三行小表单(类别 / 说明 /
 * 期望结果),不弹窗。一人一条回答一票,改票 / 撤回都走同一个 upsert / delete。
 * 这轮用的 skill 由 ChatMessagesPane 从本轮的 Skill 工具帧算好传进来,用户可改。
 * 同一条回答一人只有一行:调查卡先答过的,这里改票沿用 source='survey',统计里不丢一条答复。
 */
export type MessageFeedbackControlProps = {
  messageId: string;
  feedback: MessageFeedbackRow | null;
  skillHint: string | null;
  onSubmit: (messageId: string, payload: FeedbackPayload) => Promise<unknown>;
  onRemove: (messageId: string) => Promise<void>;
};

const CATEGORIES: FeedbackCategory[] = ['wrong_result', 'not_as_asked', 'wrong_tool', 'too_slow', 'other'];

export default function MessageFeedbackControl({ messageId, feedback, skillHint, onSubmit, onRemove }: MessageFeedbackControlProps) {
  const { t } = useTranslation('chat');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory | null>((feedback?.category as FeedbackCategory | null) ?? null);
  const [note, setNote] = useState(feedback?.note ?? '');
  const [expected, setExpected] = useState(feedback?.expected_output ?? '');
  const [skill, setSkill] = useState(feedback?.skill_hint ?? skillHint ?? '');

  const verdict = feedback?.status === 'answered' ? feedback.verdict : null;
  const isUp = verdict === 1;
  const isDown = verdict === -1;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      toast({ message: t('feedback.failed', { defaultValue: '反馈没有保存成功' }), description: error instanceof Error ? error.message : undefined, variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleUp = () => run(async () => {
    if (isUp) { await onRemove(messageId); return; }
    setOpen(false);
    await onSubmit(messageId, { source: feedback?.source ?? 'vote', verdict: 1, skillHint: skill || skillHint || null });
  });

  /**
   * hl(09-24 P2-20):**打开表单时用最新的 `feedback` 重填。**
   * 四个字段的初值只在首渲染取,而反馈列表是后到的 —— 已经 👎 过的回答,表单打开是空的,
   * 改个类别再提交就把之前写的说明和期望结果清掉了(upsert 整行覆盖)。
   */
  const openForm = () => {
    setCategory((feedback?.category as FeedbackCategory | null) ?? null);
    setNote(feedback?.note ?? '');
    setExpected(feedback?.expected_output ?? '');
    setSkill(feedback?.skill_hint ?? skillHint ?? '');
    setOpen(true);
  };

  const handleDown = () => {
    if (open) { setOpen(false); return; }
    openForm();
  };

  const handleSubmitDown = () => run(async () => {
    await onSubmit(messageId, {
      source: feedback?.source ?? 'vote', verdict: -1, category, note: note.trim() || null,
      expectedOutput: expected.trim() || null, skillHint: skill.trim() || skillHint || null,
    });
    setOpen(false);
  });

  const handleRetract = () => run(async () => {
    await onRemove(messageId);
    setOpen(false);
  });

  const base = 'grid h-6 w-6 place-items-center rounded-md transition-colors hover:bg-accent';
  const tone = (active: boolean) => (active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground');

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={handleUp}
          disabled={busy}
          className={`${base} ${tone(isUp)}`}
          aria-pressed={isUp}
          aria-label={t('feedback.up', { defaultValue: '有帮助' })}
          title={t('feedback.up', { defaultValue: '有帮助' })}
        >
          <ThumbsUp className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={handleDown}
          disabled={busy}
          className={`${base} ${tone(isDown)}`}
          aria-pressed={isDown}
          aria-expanded={open}
          aria-label={t('feedback.down', { defaultValue: '有问题' })}
          title={t('feedback.down', { defaultValue: '有问题' })}
        >
          <ThumbsDown className="h-3.5 w-3.5" aria-hidden />
        </button>
        {isDown && !open && (
          <span className="ml-1 font-sans text-[11px] text-muted-foreground">
            {t('feedback.markedDown', { defaultValue: '已标记有问题 · 点击可改' })}
          </span>
        )}
      </div>
      {open && (
        <div
          className="w-full max-w-screen-sm rounded-panel border border-border bg-card p-3 font-sans text-xs text-body"
          data-testid="feedback-form"
        >
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
            <span className="text-muted-foreground">{t('feedback.category', { defaultValue: '问题类别' })}</span>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCategory(category === key ? null : key)}
                  aria-pressed={category === key}
                  className={`h-6 rounded-full border px-2.5 text-[11px] transition-colors ${category === key ? 'border-transparent bg-accent text-accent-foreground' : 'border-border bg-card text-body hover:border-border-strong'}`}
                >
                  {t(`feedback.categories.${key}`, { defaultValue: key })}
                </button>
              ))}
            </div>
            <label className="text-muted-foreground" htmlFor={`fb-note-${messageId}`}>{t('feedback.note', { defaultValue: '说明' })}</label>
            <input
              id={`fb-note-${messageId}`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={2000}
              placeholder={t('feedback.notePlaceholder', { defaultValue: '哪里不对?一句话就行' })}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
            />
            <label className="text-muted-foreground" htmlFor={`fb-expected-${messageId}`}>{t('feedback.expected', { defaultValue: '期望结果' })}</label>
            <textarea
              id={`fb-expected-${messageId}`}
              value={expected}
              onChange={(event) => setExpected(event.target.value)}
              rows={2}
              maxLength={8000}
              placeholder={t('feedback.expectedPlaceholder', { defaultValue: '可不填。填了就是训练时的判据 —— 越具体越好' })}
              className="resize-none rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
            />
            <label className="text-muted-foreground" htmlFor={`fb-skill-${messageId}`}>{t('feedback.skill', { defaultValue: '这次的技能' })}</label>
            <div className="flex items-center gap-2">
              <input
                id={`fb-skill-${messageId}`}
                value={skill}
                onChange={(event) => setSkill(event.target.value)}
                maxLength={128}
                placeholder={t('feedback.skillPlaceholder', { defaultValue: '没调技能可留空' })}
                className="w-56 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground focus:border-primary focus:outline-none"
              />
              {skillHint && <span className="text-muted-foreground">{t('feedback.skillAuto', { defaultValue: '自动识别,可改' })}</span>}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            {isDown && (
              <button type="button" onClick={handleRetract} disabled={busy} className="h-7 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                {t('feedback.retract', { defaultValue: '撤回' })}
              </button>
            )}
            <button type="button" onClick={() => setOpen(false)} disabled={busy} className="h-7 rounded-md border border-border px-2.5 text-xs text-foreground hover:border-border-strong">
              {t('feedback.cancel', { defaultValue: '取消' })}
            </button>
            <button type="button" onClick={handleSubmitDown} disabled={busy} className="prism-action h-7 rounded-md border px-3 text-xs disabled:opacity-50">
              {t('feedback.submit', { defaultValue: '提交' })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
