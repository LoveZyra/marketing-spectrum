import { describe, expect, it } from 'vitest';

import {
  DELETION_AUDIT_EVENTS, type AuditTranslator, auditEventLabel, describeAuditDetail,
  isDeletionAuditEvent, looksTruncatedJson, parseAuditDetail,
} from './auditDetail';

/**
 * gk:审计页把删除类事件的 JSON detail 翻成一句人话。
 * 事故里最该答得上的一句是"谁、几点、从哪、删了我哪条、盘上的东西还在不在"。
 *
 * 不传翻译器时用中文兜底串(identityAuditTranslator),所以这些断言就是中文界面下的实际输出。
 */
describe('describeAuditDetail', () => {
  /**
   * 入口标签是当前缀拼的,每一条都要能直接接上动词。
   * gk 拼出过「清空归档永久删除了会话」(少一个「时」),这一条钉住所有入口。
   */
  it('每个入口标签拼到动词前都读得通', () => {
    const cases: Array<[string, string]> = [
      ['session', '从侧栏永久删除了会话'],
      ['bulk', '批量操作中永久删除了会话'],
      ['empty_archived', '清空归档时永久删除了会话'],
      ['project', '删除项目时永久删除了会话'],
      ['retention', '归档保留期到期时永久删除了会话'],
    ];
    for (const [entry, expected] of cases) {
      const text = describeAuditDetail('session_deleted', JSON.stringify({ entry, sessionName: 'X' }));
      expect(text, entry).toBe(`${expected}「X」`);
    }
  });

  it('单条永久删除:入口 + 会话名 + 项目 + 最后活动 + transcript 去向', () => {
    const detail = JSON.stringify({
      entry: 'session', sessionId: 's1', sessionName: '胡萍', projectName: '26年国庆报告',
      lastActivity: '2026-09-14T14:23:00.000Z', transcriptMoved: true,
    });
    const text = describeAuditDetail('session_deleted', detail);
    expect(text).toContain('从侧栏永久删除了会话「胡萍」');
    expect(text).toContain('项目「26年国庆报告」');
    expect(text).toContain('最后活动');
    expect(text).toContain('transcript 已移入最近删除');
  });

  it('清空归档:条数 + 名字(动词与数字之间要断开,不是"移入最近删除3 条")', () => {
    const text = describeAuditDetail('archived_sessions_emptied', JSON.stringify({ entry: 'empty_archived', count: 3, names: ['合并版本', '冷天', 'hd'] }));
    expect(text).toBe('清空归档,移入最近删除了 3 条会话:「合并版本」「冷天」「hd」');
  });

  it('删项目:项目名 + 进最近删除的条数', () => {
    const text = describeAuditDetail('project_deleted', JSON.stringify({ entry: 'project', projectName: '报告', count: 2, names: ['甲', '乙'] }));
    expect(text).toContain('永久删除了项目「报告」');
    expect(text).toContain('2 条会话移入最近删除');
  });

  it('非删除类事件、或 detail 不是 JSON:原样返回', () => {
    expect(describeAuditDetail('login', 'ok')).toBe('ok');
    expect(describeAuditDetail('session_deleted', 'not json')).toBe('not json');
    expect(describeAuditDetail('session_deleted', null)).toBe('');
  });

  /**
   * 服务端把 detail 截到 1000 字符(`detail.slice(0, 1000)`),批量那几条带十个会话名时
   * 真会截断。截断的 JSON 解析必失败 —— 不说一声就是表格里一格半截 JSON,看着像数据坏了。
   */
  it('detail 被截断(半截 JSON):明说被截断,而不是原样丢一格乱码', () => {
    const truncated = '{"entry":"empty_archived","count":37,"names":["合并版本","冷天"';
    expect(looksTruncatedJson(truncated)).toBe(true);
    expect(parseAuditDetail(truncated)).toBeNull();
    const text = describeAuditDetail('archived_sessions_emptied', truncated);
    expect(text.startsWith('(详情过长已被截断)')).toBe(true);
    expect(text).toContain('"count":37');
    // 完整 JSON 与普通文本都不该被当成截断
    expect(looksTruncatedJson('{"a":1}')).toBe(false);
    expect(looksTruncatedJson('plain text')).toBe(false);
  });

  it('事件标签与分组', () => {
    expect(auditEventLabel('session_deleted')).toBe('永久删除了会话');
    expect(auditEventLabel('login')).toBe('login');
    expect(isDeletionAuditEvent('session_trash_restored')).toBe(true);
    expect(DELETION_AUDIT_EVENTS).toHaveLength(9);
    expect(parseAuditDetail('{"entry":"session"}')).toEqual({ entry: 'session' });
  });

  /**
   * 文案必须**全部**过翻译器 —— 这一条是英文界面的回归闸门:上一版把中文写死在
   * 模块里,英文界面下「事件」列与「详情」列突然变中文(而 gk 其它审计文案都走 locale)。
   * 这里的假翻译器把每个键换成 `[键]`,于是任何漏过 t 的中文都会留在输出里。
   */
  describe('i18n', () => {
    const keysOnly: AuditTranslator = (key) => `[${key}]`;

    it('事件标签走 audit.event.<事件>', () => {
      expect(auditEventLabel('session_deleted', keysOnly)).toBe('[audit.event.session_deleted]');
      // 不认识的事件仍原样给(它是个稳定标识,不该翻)
      expect(auditEventLabel('login', keysOnly)).toBe('login');
    });

    it('详情里没有一个写死的中文片段', () => {
      const detail = JSON.stringify({
        entry: 'session', sessionId: 's1', sessionName: 'Hu Ping', projectName: 'Report',
        lastActivity: '2026-09-14T14:23:00.000Z', transcriptMoved: true,
      });
      const text = describeAuditDetail('session_deleted', detail, keysOnly);
      expect(text).not.toMatch(/[一-龥]/);
      // 最外层是"带括注"那个模板(假翻译器不做插值,所以只看得到最外层那个键)
      expect(text).toBe('[audit.detail.withExtras]');

      for (const event of DELETION_AUDIT_EVENTS) {
        const rendered = describeAuditDetail(event, JSON.stringify({
          entry: 'bulk', sessionId: 's1', sessionName: 'name', projectName: 'proj',
          count: 2, names: ['a', 'b'], transcriptMoved: false, transcriptRestored: true,
        }), keysOnly);
        expect(rendered, event).not.toMatch(/[一-龥]/);
      }
    });

    it('插值用的是 i18next 的 {{name}},假翻译器不填也不会崩', () => {
      const text = describeAuditDetail('project_deleted', JSON.stringify({ projectPath: '/srv/p', count: 0 }), (key, fallback, vars) => (
        vars ? `${key}(${Object.keys(vars).join(',')})` : key
      ));
      expect(text).toContain('audit.detail.projectHead(verb,name,count,names)');
    });
  });
});
