import { Trash2, MessageSquarePlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SessionRemovedInfo } from '../../utils/sessionRemoved';

type Props = {
  info: SessionRemovedInfo;
  /** 输入框里还没发出去的字 —— 有的话「新建会话继续」会把它带过去。 */
  pendingDraft: string;
  onStartNewSession: (() => void) | null;
};

const formatTime = (value: string): string => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

/**
 * gk:「这条会话已被删除」—— 替换掉输入框的那一块。
 *
 * 2026-09-14 生产的那张截图:一句给开发者看的英文报错出现两次,中间夹着用户那句话,
 * 还有一个只会再撞一次的「重发上一条消息」。这里把它换成三件事:发生了什么(谁、几点、
 * 从哪删的)、东西在哪(最近删除,保留期内可恢复)、下一步(新建会话,草稿带过去)。
 */
export default function SessionRemovedNotice({ info, pendingDraft, onStartNewSession }: Props) {
  const { t } = useTranslation('chat');

  const headline = info.reason === 'not_found'
    ? t('sessionRemoved.notFoundTitle', '这条会话已不存在')
    : info.reason === 'project_deleted'
      ? t('sessionRemoved.projectDeletedTitle', '这条会话随项目一起被删除了')
      : t('sessionRemoved.deletedTitle', '这条会话已被删除');

  const detail = info.reason === 'not_found'
    ? t('sessionRemoved.notFoundDetail', '它可能已被删除,或者你已无权访问。发送前请先确认它是否在「最近删除」里。')
    : info.deletedBy
      ? t('sessionRemoved.deletedByDetail', {
        who: info.deletedBy,
        when: formatTime(info.at),
        defaultValue: '由 {{who}} 于 {{when}} 删除。',
      })
      : t('sessionRemoved.deletedDetail', { when: formatTime(info.at), defaultValue: '于 {{when}} 被删除。' });

  /**
   * `not_found` 不给"它在最近删除里"这句话。
   *
   * 那条路有三个来源,两个是**看不见了**(共享被收回、项目改了权限),只有一个是
   * 真被删了 —— 上面那句 detail 已经说了"可能已被删除,或者你已无权访问",紧接着
   * 再断言"它已进入最近删除、可恢复"就是自相矛盾,还会让人去回收站里找一条
   * 本来就不在那儿的会话。
   */
  const restoreHint = info.reason === 'not_found'
    ? null
    : info.restorable
      ? t('sessionRemoved.restoreHint', '它已进入「最近删除」(侧栏 → 归档视图底部),保留期内可由项目负责人恢复;恢复后这里会自动回到原样。')
      : t('sessionRemoved.notRestorableHint', '这条会话不能恢复。');

  return (
    <div className="px-2 pb-3 sm:px-4 md:px-4" data-session-removed-notice="true">
      <div className="mx-auto w-full max-w-[52.25rem] rounded-panel border border-border bg-card p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Trash2 className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{headline}</p>
            <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
            {restoreHint && <p className="mt-1 text-xs text-muted-foreground">{restoreHint}</p>}
            {pendingDraft.trim().length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('sessionRemoved.draftKept', '你刚才输入的内容还在,新建会话会把它带过去。')}
              </p>
            )}
          </div>
        </div>
        {onStartNewSession && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onStartNewSession}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              {t('sessionRemoved.startNew', '新建会话继续')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
