/**
 * gk:删除类审计事件的 detail 是一段 JSON(服务端 sessions.service 的 SessionAuditDetail),
 * 这里把它翻成一句人话。别的事件的 detail 仍是自由文本,原样返回。
 *
 * 形状(字段都可选):
 *   { entry, sessionId, sessionName, projectPath, projectName, lastActivity,
 *     transcriptMoved, transcriptRestored, count, names[], reason, retentionDays }
 *
 * ## 为什么每一段文案都要过 `t`
 *
 * 这个模块第一版把中文写死在代码里。而在它之前,审计表格的「事件」列显示的是
 * `session_deleted`、「详情」列显示的是原始 JSON —— 两样都与语言无关。写死之后,
 * 英文界面下这两列突然变成中文,而 gk 新加的其它审计文案(`audit.mineTitle` 之类)
 * 都是走 locale 的 —— 同一张表里一半中文一半英文。
 *
 * 句子的标点与空格也归 locale 管(中文不加空格、用「」和,;英文要空格和引号),
 * 所以给的是**整句模板 + 插值**,而不是在代码里拼标点。
 */

export type AuditDetailShape = {
  entry?: string;
  sessionId?: string;
  sessionName?: string | null;
  projectPath?: string | null;
  projectName?: string | null;
  lastActivity?: string | null;
  transcriptMoved?: boolean;
  transcriptRestored?: boolean;
  count?: number;
  names?: string[];
  reason?: string;
  retentionDays?: number;
};

/**
 * 最小翻译器:`(键, 中文兜底, 插值)`。
 *
 * 刻意不直接吃 i18next 的 `TFunction` —— 那个类型带一大堆重载,纯函数模块里为它
 * 做类型体操不值得,单测也没法喂。组件侧一行适配(见 AuditLogList 的 translate)。
 */
export type AuditTranslator = (
  key: string,
  fallback: string,
  vars?: Record<string, string | number>,
) => string;

/** 测试与兜底用:不翻译,直接用中文兜底串并把 `{{x}}` 填上。 */
export const identityAuditTranslator: AuditTranslator = (_key, fallback, vars) => (
  vars
    ? fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(vars[name] ?? ''))
    : fallback
);

export const DELETION_AUDIT_EVENTS = [
  'session_deleted',
  'session_archived',
  'sessions_bulk_deleted',
  'sessions_bulk_archived',
  'archived_sessions_emptied',
  'project_deleted',
  'project_archived',
  'session_trash_restored',
  'session_trash_purged',
] as const;

export type DeletionAuditEvent = (typeof DELETION_AUDIT_EVENTS)[number];

export function isDeletionAuditEvent(event: string): event is DeletionAuditEvent {
  return (DELETION_AUDIT_EVENTS as readonly string[]).includes(event);
}

/**
 * detail 解析。返回 null 有两种:不是 JSON(别的事件的自由文本),或者**被截断了**。
 *
 * 截断是真会发生的:服务端 `auditLogDb.record` 把 detail 截到 1000 字符
 * (`detail.slice(0, 1000)`),而批量删除那几条会带十个会话名。截断的 JSON 解析必失败,
 * 于是整段原样打进表格 —— 一格半截 JSON。`truncated` 让调用方能说一句"详情被截断"。
 */
export function parseAuditDetail(detail: string | null | undefined): AuditDetailShape | null {
  if (!detail) return null;
  const trimmed = detail.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as AuditDetailShape) : null;
  } catch {
    return null;
  }
}

/** 看着像被截掉尾巴的 JSON(以 `{` 开头但解析不出来)。 */
export function looksTruncatedJson(detail: string | null | undefined): boolean {
  if (!detail) return false;
  const trimmed = detail.trim();
  if (!trimmed.startsWith('{')) return false;
  return parseAuditDetail(trimmed) === null;
}

/**
 * 入口标签**是当前缀用的**(`{{entry}}{{verb}}{{target}}`),所以每一条都要能直接
 * 接上「永久删除了会话…」。少一个连接词就会拼出「清空归档永久删除了会话」这种句子
 * (2026-09-15 实测)。改这里时记得连 locale 里的 `audit.entry.*` 一起改。
 */
const ENTRY_FALLBACKS: Record<string, string> = {
  session: '从侧栏',
  bulk: '批量操作中',
  empty_archived: '清空归档时',
  project: '删除项目时',
  retention: '归档保留期到期时',
  api: '外部 API',
  restore: '',
  purge: '',
};

const EVENT_FALLBACKS: Record<DeletionAuditEvent, string> = {
  session_deleted: '永久删除了会话',
  session_archived: '归档了会话',
  sessions_bulk_deleted: '批量永久删除了',
  sessions_bulk_archived: '批量归档了',
  // 「了」不是可有可无:后面紧接着的是" 3 条会话",少了它是"移入最近删除3 条会话"。
  archived_sessions_emptied: '清空归档,移入最近删除了',
  project_deleted: '永久删除了项目',
  project_archived: '归档了项目',
  session_trash_restored: '从最近删除恢复了会话',
  session_trash_purged: '清除了最近删除里的会话',
};

/** 事件本身的短标签(表格「事件」列用)。不认识的事件原样给 —— 它就是个稳定标识。 */
export function auditEventLabel(event: string, t: AuditTranslator = identityAuditTranslator): string {
  return isDeletionAuditEvent(event) ? t(`audit.event.${event}`, EVENT_FALLBACKS[event]) : event;
}

const formatWhen = (value: string): string => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

/**
 * 把一条删除类记录翻成人话。给不出更多信息时退回 detail 原文。
 *
 *   wjx 从侧栏永久删除了会话「胡萍」(项目「26年国庆报告」,最后活动 9-14 22:23,transcript 已移入最近删除)
 */
export function describeAuditDetail(
  event: string,
  detail: string | null | undefined,
  t: AuditTranslator = identityAuditTranslator,
): string {
  const parsed = parseAuditDetail(detail);
  if (!isDeletionAuditEvent(event) || !parsed) {
    // 半截 JSON 不如实说一句:原样打出来只是一格乱码,看的人以为是数据坏了。
    if (looksTruncatedJson(detail)) {
      return t('audit.detail.truncated', '(详情过长已被截断){{raw}}', { raw: (detail ?? '').trim() });
    }
    return detail ?? '';
  }

  const quote = (value: string | null | undefined): string => (
    value && value.trim() ? t('audit.detail.quoted', '「{{value}}」', { value: value.trim() }) : ''
  );
  const verb = t(`audit.event.${event}`, EVENT_FALLBACKS[event]);
  const entry = parsed.entry ? t(`audit.entry.${parsed.entry}`, ENTRY_FALLBACKS[parsed.entry] ?? '') : '';
  const project = parsed.projectName
    ? t('audit.detail.project', '项目{{name}}', { name: quote(parsed.projectName) })
    : parsed.projectPath
      ? t('audit.detail.projectPath', '项目 {{path}}', { path: parsed.projectPath })
      : '';

  const extras: string[] = [];
  if (project && event !== 'project_deleted' && event !== 'project_archived') extras.push(project);
  if (parsed.lastActivity) extras.push(t('audit.detail.lastActivity', '最后活动 {{when}}', { when: formatWhen(parsed.lastActivity) }));
  if (parsed.transcriptMoved === true) extras.push(t('audit.detail.transcriptMoved', 'transcript 已移入最近删除'));
  if (parsed.transcriptMoved === false && event === 'session_deleted') extras.push(t('audit.detail.transcriptKept', 'transcript 未搬动'));
  if (parsed.transcriptRestored === true) extras.push(t('audit.detail.transcriptRestored', 'transcript 已放回'));
  if (parsed.reason) extras.push(parsed.reason);
  const separator = t('audit.detail.separator', ',');

  const withExtras = (head: string): string => (
    extras.length > 0
      ? t('audit.detail.withExtras', '{{head}}({{extras}})', { head, extras: extras.join(separator) })
      : head
  );
  const nameList = (names: string[] | undefined): string => (
    names && names.length > 0
      ? t('audit.detail.nameList', ':{{names}}', { names: names.map((name) => quote(name)).join('') })
      : ''
  );

  switch (event) {
    case 'session_deleted':
    case 'session_archived':
    case 'session_trash_restored':
    case 'session_trash_purged': {
      const target = quote(parsed.sessionName)
        || (parsed.sessionId ? t('audit.detail.sessionId', ' {{id}}', { id: parsed.sessionId }) : '');
      return withExtras(t('audit.detail.sessionHead', '{{entry}}{{verb}}{{target}}', { entry, verb, target }));
    }
    case 'sessions_bulk_deleted':
    case 'sessions_bulk_archived':
    case 'archived_sessions_emptied': {
      const count = typeof parsed.count === 'number'
        ? t('audit.detail.sessionCount', ' {{count}} 条会话', { count: parsed.count })
        : '';
      return t('audit.detail.bulkHead', '{{verb}}{{count}}{{names}}', { verb, count, names: nameList(parsed.names) });
    }
    case 'project_deleted':
    case 'project_archived': {
      const count = typeof parsed.count === 'number'
        ? t('audit.detail.movedToTrashCount', ',{{count}} 条会话移入最近删除', { count: parsed.count })
        : '';
      const name = parsed.projectName
        ? quote(parsed.projectName)
        : parsed.projectPath
          ? t('audit.detail.sessionId', ' {{id}}', { id: parsed.projectPath })
          : '';
      return t('audit.detail.projectHead', '{{verb}}{{name}}{{count}}{{names}}', {
        verb, name, count, names: nameList(parsed.names),
      });
    }
    default:
      return detail ?? '';
  }
}
