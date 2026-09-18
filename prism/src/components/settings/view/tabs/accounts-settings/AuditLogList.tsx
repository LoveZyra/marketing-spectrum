import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Filter, RefreshCw, ScrollText, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../../../utils/api';
import { middleTruncate } from '../../../../../utils/middleTruncate';

import {
  DELETION_AUDIT_EVENTS, type AuditTranslator, auditEventLabel, describeAuditDetail, isDeletionAuditEvent,
} from './auditDetail';

type AuditEntry = {
  id: number;
  user_id: number | null;
  username: string | null;
  event: string;
  outcome: string;
  ip: string | null;
  detail: string | null;
  created_at: string;
};

type AuditResponse = {
  entries?: AuditEntry[];
  total?: number;
  error?: string;
};

const PAGE_SIZE = 20;

/**
 * 事件按**排查时会一起看的东西**分组,不按代码里的定义顺序。
 *
 * 27 个事件平铺成一个下拉,等于没筛 —— 没人记得住哪几个是一伙的。
 * 分组的判据是"用户带着什么问题来":
 *   - 账号出事了 → 登录/锁定/改密/停用
 *   - 东西没了 → 项目删除/归档/改属主
 *   - 行为变了 → 技能装卸(共用技能库,别人卸掉会静默改变你的会话)
 *   - 凭据 → API key / 网关凭据 / 票据
 *
 * `events` 里的字符串必须和服务端 `AuditEvent` 联合类型对得上;
 * 对不上的话筛出来是空,不会报错 —— 所以 audit-filter 那组测试里
 * 有一条专门钉住"空数组 = 不筛",免得把拼错当成没结果。
 */
const EVENT_GROUPS: ReadonlyArray<{ key: string; labelZh: string; events: readonly string[] }> = [
  {
    key: 'auth',
    labelZh: '登录与账号',
    events: ['login', 'login_failed', 'login_locked', 'logout', 'register', 'register_pending',
      'login_unapproved', 'password_reset_by_admin', 'user_deactivated', 'user_activated',
      'user_approved', 'user_rejected'],
  },
  {
    key: 'projects',
    labelZh: '项目变更',
    events: ['project_owner_changed', 'projects_bulk_deleted', 'projects_bulk_archived',
      'attachment_quota_changed'],
  },
  {
    // gk:会话与项目的删除 / 归档 / 恢复 —— "我的会话怎么没了、谁删的"从这里查。
    key: 'deletions',
    labelZh: '会话与项目删除',
    events: [...DELETION_AUDIT_EVENTS],
  },
  {
    key: 'skills',
    labelZh: '技能装卸',
    events: ['skill_installed', 'skill_removed'],
  },
  {
    key: 'credentials',
    labelZh: '凭据与票据',
    events: ['api_key_created', 'api_key_deleted', 'api_key_toggled', 'credential_created',
      'credential_deleted', 'token_revoked', 'ws_ticket_issued'],
  },
];

const formatTime = (value: string): string => {
  const parsed = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

/**
 * 审计日志列表(登录/登出/审批/改密/停用等安全事件)。
 * 服务端裁剪可见范围:root 全量,普通用户只有自己的行 —— 组件两处通用。
 */
type AuditLogListProps = {
  /** gk:个人账号页上叫「与我有关的操作记录」—— 非 root 看到的是"我做的 + 对我做的"。 */
  title?: string;
};

export default function AuditLogList({ title }: AuditLogListProps = {}) {
  const { t } = useTranslation('settings');
  /**
   * gk:审计文案的适配器。auditDetail 是纯函数模块(单测里喂得进假翻译器),
   * 所以它要的是 `(键, 中文兜底, 插值)` 这个最小形状,这里把 i18next 的 t 折过去。
   */
  const translateAudit = useCallback<AuditTranslator>(
    (key, fallback, vars) => t(key, { defaultValue: fallback, ...(vars ?? {}) }),
    [t],
  );
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupKey, setGroupKey] = useState('');
  const [outcome, setOutcome] = useState('');
  const [username, setUsername] = useState('');

  /*
   * 筛选条件用 ref 传给 load,而不是进 useCallback 的依赖。
   *
   * 进依赖的话 `load` 每次改筛选都换新引用,而下面那个 `useEffect([load])`
   * 会跟着重跑 —— 在用户名输入框里每敲一个字都发一次请求。
   * 这里要的是"改了条件之后**点一下**才查",所以取值放到调用的那一刻。
   */
  const filtersRef = useRef({ groupKey: '', outcome: '', username: '' });
  filtersRef.current = { groupKey, outcome, username };

  const load = useCallback(async (targetPage: number) => {
    setLoading(true);
    setError(null);
    try {
      const current = filtersRef.current;
      const group = EVENT_GROUPS.find((candidate) => candidate.key === current.groupKey);
      const response = await api.auth.auditLog({
        limit: PAGE_SIZE,
        offset: targetPage * PAGE_SIZE,
        events: group ? [...group.events] : [],
        outcome: current.outcome,
        username: current.username,
      });
      const payload = (await response.json()) as AuditResponse;
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to load audit log');
      }
      setEntries(payload.entries ?? []);
      setTotal(payload.total ?? 0);
      setPage(targetPage);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(0);
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ScrollText className="h-4 w-4 text-muted-foreground" />
          {title ?? t('audit.title', '安全审计日志')}
          <span className="text-xs font-normal text-muted-foreground">
            {t('audit.total', { count: total, defaultValue: `共 ${total} 条` })}
          </span>
        </h3>
        <button
          type="button"
          onClick={() => void load(page)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-body transition-colors hover:border-border-strong hover:bg-card hover:text-foreground"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'text-primary' : ''}`} />
          {t('audit.refresh', '刷新')}
        </button>
      </div>

      {/*
        筛选栏。改条件不自动查 —— 用户名是输入框,自动查等于每敲一个字发一次请求。
        改完按回车或点「筛选」。
      */}
      <div className="flex flex-wrap items-center gap-2">
        <Filter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <select
          value={groupKey}
          onChange={(event) => setGroupKey(event.target.value)}
          className="rounded-md border border-border bg-card py-1.5 pl-2 pr-7 text-xs text-body focus:border-border-strong focus:outline-none"
        >
          <option value="">{t('audit.filter.allEvents', '全部事件')}</option>
          {EVENT_GROUPS.map((group) => (
            <option key={group.key} value={group.key}>
              {t(`audit.filter.group.${group.key}`, group.labelZh)}
            </option>
          ))}
        </select>

        <select
          value={outcome}
          onChange={(event) => setOutcome(event.target.value)}
          className="rounded-md border border-border bg-card py-1.5 pl-2 pr-7 text-xs text-body focus:border-border-strong focus:outline-none"
        >
          <option value="">{t('audit.filter.allOutcomes', '全部结果')}</option>
          <option value="success">{t('audit.filter.success', '成功')}</option>
          <option value="failure">{t('audit.filter.failure', '失败')}</option>
        </select>

        {/*
          用户名框对**所有人**都显示,不只 root。
          非 root 在这里输别人的名字得到的是空结果(服务端的可见范围闸门在筛选之前),
          所以它不是一个泄漏入口;而普通用户用自己的名字筛没有意义、也不碍事。
          按角色藏这个框反而要在前端复述一遍权限规则 —— 那正是这个仓库
          在 A-2 上栽过的"同一条判据写两遍"。
        */}
        <input
          type="text"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void load(0); }}
          placeholder={t('audit.filter.usernamePlaceholder', '用户名(可留空)')}
          className="w-40 rounded-md border border-border bg-card px-2 py-1.5 text-xs text-body placeholder:text-muted-foreground focus:border-border-strong focus:outline-none"
        />

        <button
          type="button"
          onClick={() => void load(0)}
          disabled={loading}
          className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-body transition-colors hover:border-border-strong hover:bg-card hover:text-foreground disabled:opacity-40"
        >
          {t('audit.filter.apply', '筛选')}
        </button>

        {(groupKey || outcome || username) && (
          <button
            type="button"
            onClick={() => { setGroupKey(''); setOutcome(''); setUsername('');
              filtersRef.current = { groupKey: '', outcome: '', username: '' }; void load(0); }}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-3 w-3" />
            {t('audit.filter.clear', '清空')}
          </button>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-card text-xs text-muted-foreground">
            <tr>
              <th className="w-px whitespace-nowrap px-3 py-2 text-left font-medium">{t('audit.columns.time', '时间')}</th>
              <th className="w-px whitespace-nowrap px-3 py-2 text-left font-medium">{t('audit.columns.user', '用户')}</th>
              <th className="w-px whitespace-nowrap px-3 py-2 text-left font-medium">{t('audit.columns.event', '事件')}</th>
              {/* IP 在窄容器里先让位:它远不如「谁、几点、做了什么」重要 */}
              <th className="hidden w-px whitespace-nowrap px-3 py-2 text-left font-medium lg:table-cell">IP</th>
              <th className="px-3 py-2 text-left font-medium">{t('audit.columns.detail', '详情')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {loading
                    ? t('audit.loading', '加载中…')
                    : (groupKey || outcome || username)
                      ? t('audit.emptyFiltered', '没有符合条件的记录。换个条件或点「清空」。')
                      : t('audit.empty', '暂无记录')}
                </td>
              </tr>
            )}
            {entries.map((entry) => (
              <tr key={entry.id} className="border-t border-border">
                <td className="whitespace-nowrap px-3 py-1.5 text-xs tabular-nums text-muted-foreground">
                  {formatTime(entry.created_at)}
                </td>
                {/* 用户名过长时中间省略 —— 尾部省略会把 zhangsan-2024/2025 截成同一个名字 */}
                <td className="max-w-32 whitespace-nowrap px-3 py-1.5 text-xs font-medium" title={entry.username ?? ''}>
                  {entry.username ? middleTruncate(entry.username, 14) : '—'}
                </td>
                {/* 事件列锁一行:列一窄,「从最近删除恢复了会话」会被折成一字一行 */}
                <td className="w-px whitespace-nowrap px-3 py-1.5">
                  <span
                    /* -ml-1.5 抵掉徽标自己的 px-1.5,文字左边才与表头「事件」对齐(同账号审批表的状态列) */
                    className={`-ml-1.5 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] ${isDeletionAuditEvent(entry.event) ? '' : 'font-mono'} ${
                      entry.outcome === 'failure'
                        ? 'bg-muted text-muted-foreground'
                        : 'bg-muted text-body'
                    }`}
                    title={entry.event}
                  >
                    {auditEventLabel(entry.event, translateAudit)}
                  </span>
                </td>
                <td className="hidden whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-muted-foreground lg:table-cell">
                  {entry.ip ?? '—'}
                </td>
                {/* gk:删除类记录的 detail 是 JSON,翻成人话;其余原样。悬停仍能看到原文。 */}
                <td
                  className={`px-3 py-1.5 text-xs text-muted-foreground ${isDeletionAuditEvent(entry.event) ? 'whitespace-normal break-words' : 'max-w-64 truncate'}`}
                  title={entry.detail ?? ''}
                >
                  {describeAuditDetail(entry.event, entry.detail, translateAudit) || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            disabled={page === 0 || loading}
            onClick={() => void load(page - 1)}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 transition-colors hover:border-border-strong hover:bg-card hover:text-foreground disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t('audit.prev', '上一页')}
          </button>
          <span>
            {page + 1} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page + 1 >= totalPages || loading}
            onClick={() => void load(page + 1)}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 transition-colors hover:border-border-strong hover:bg-card hover:text-foreground disabled:opacity-40"
          >
            {t('audit.next', '下一页')}
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
