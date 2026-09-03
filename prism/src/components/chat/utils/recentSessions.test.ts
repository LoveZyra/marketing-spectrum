import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Project } from '../../../types/app';

import { buildRecentSessions, greetingKey } from './recentSessions';

/**
 * ef:首页空态(批次 1)。
 *
 * 「最近会话」跨项目按最后活动时间取前 N 条;数据就是侧栏那份 projects,
 * 不另发请求。问候语按小时分四段。
 */
describe('buildRecentSessions', () => {
  const projects: Project[] = [
    {
      projectId: 'p1', displayName: 'marketing', fullPath: '/w/marketing',
      sessions: [
        { id: 's1', summary: '大促复盘', lastActivity: '2026-09-02T08:00:00Z' },
        { id: 's2', summary: '口径核对', lastActivity: '2026-09-01T08:00:00Z' },
      ],
    },
    {
      projectId: 'p2', displayName: 'recsys', fullPath: '/w/recsys',
      sessions: [
        { id: 's3', name: '召回对比', updated_at: '2026-09-02T09:00:00Z' },
        { id: 's4', createdAt: 'not-a-date' },
        { id: '', summary: '没有 id 的脏数据' },
      ],
    },
  ];

  it('跨项目按时间倒序,默认取 3 条,标题回落到 summary / name / 默认名', () => {
    const recents = buildRecentSessions(projects, 3, '新会话');
    expect(recents.map((entry) => entry.id)).toEqual(['s3', 's1', 's2']);
    expect(recents[0]).toMatchObject({ title: '召回对比', projectId: 'p2', projectName: 'recsys' });
    expect(recents[1].title).toBe('大促复盘');
  });

  it('时间解析失败的会话排最后、time 为空串;没有 id 的跳过', () => {
    const recents = buildRecentSessions(projects, 10, '新会话');
    expect(recents).toHaveLength(4);
    expect(recents[3]).toMatchObject({ id: 's4', title: '新会话', time: '', timestamp: 0 });
  });

  it('空输入 / limit 0 → 空数组', () => {
    expect(buildRecentSessions(undefined)).toEqual([]);
    expect(buildRecentSessions([])).toEqual([]);
    expect(buildRecentSessions(projects, 0)).toEqual([]);
  });
});

describe('greetingKey', () => {
  it('按小时分四段,边界落在 5 / 11 / 13 / 18', () => {
    expect(greetingKey(4)).toBe('evening');
    expect(greetingKey(5)).toBe('morning');
    expect(greetingKey(10)).toBe('morning');
    expect(greetingKey(11)).toBe('noon');
    expect(greetingKey(12)).toBe('noon');
    expect(greetingKey(13)).toBe('afternoon');
    expect(greetingKey(17)).toBe('afternoon');
    expect(greetingKey(18)).toBe('evening');
    expect(greetingKey(23)).toBe('evening');
  });
});

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('ef 批次 1 界面基座(源码守门)', () => {
  it('点阵画布只挂在 .prism-canvas 上,不再铺所有 bg-background 面;圆角三档每套主题都有', () => {
    const css = readFileSync(fileURLToPath(new URL('../../../index.css', import.meta.url)), 'utf8');
    expect(css).toMatch(/\.prism-canvas \{[\s\S]*?background-image: var\(--canvas-texture\)/);
    expect(css).not.toMatch(/\[class~="bg-background"\]\s*\{/);
    expect((css.match(/--radius-dialog:/g) ?? []).length).toBe(3);
    expect((css.match(/--radius-panel:/g) ?? []).length).toBe(3);
    expect(css).toMatch(/svg\.lucide:not\(\[stroke-width="2\.5"\]\) \{\s*stroke-width: 1\.75;/);
  });

  it('首页空态:ChatMessagesPane 只在 isHome 时铺画布;输入框以 composerSlot 嵌进空态', () => {
    const pane = read('../view/subcomponents/ChatMessagesPane.tsx');
    expect(pane).toMatch(/isHome \? 'prism-canvas py-6'/);
    expect(pane).toMatch(/composerSlot=\{composerSlot\}/);
    const chat = read('../view/ChatInterface.tsx');
    expect(chat).toMatch(/composerSlot=\{isHome \? composerElement : null\}/);
    expect(chat).toMatch(/\{!isHome && composerElement\}/);
    const empty = read('../view/subcomponents/ChatEmptyState.tsx');
    expect(empty).toMatch(/data-home-empty/);
    expect(empty).toMatch(/data-home-recent/);
    expect(empty).not.toMatch(/PrismVisionPanel/);
  });

  it('输入框 / 待审批横幅 / 产出面板 / 排队卡片与正文同宽同边(52.25rem = 54.25rem − px-4)', () => {
    expect(read('../view/subcomponents/ChatComposer.tsx').match(/max-w-\[52\.25rem\]/g)?.length).toBe(2);
    expect(read('../view/subcomponents/ChangedFilesCard.tsx')).toMatch(/max-w-\[52\.25rem\]/);
    expect(read('../view/subcomponents/QueuedMessageCard.tsx')).toMatch(/max-w-\[52\.25rem\]/);
    expect(read('../view/subcomponents/ChatMessagesPane.tsx')).toMatch(/max-w-\[54\.25rem\] space-y-3 px-4/);
  });

  it('输入框只留一层描边(不再 border + inset ring);用户气泡 14/24、最宽 70%', () => {
    const prompt = read('../../../shared/view/ui/PromptInput.tsx');
    expect(prompt).not.toMatch(/prism-raised/);
    expect(prompt).toMatch(/rounded-panel border border-input bg-card/);
    const message = read('../view/subcomponents/MessageComponent.tsx');
    expect(message).toMatch(/rounded-bubble bg-card px-4 py-2\.5 text-sm leading-6/);
    expect(message).toMatch(/sm:max-w-\[70%\]/);
  });

  it('顶栏一行:标题带悬停坐标 + 铅笔改名、项目芯片、「…」四项;常驻胶囊与导出按钮撤掉', () => {
    const header = read('../../main-content/view/subcomponents/MainContentHeader.tsx');
    expect(header).toMatch(/<SessionActionsMenu/);
    expect(header).not.toMatch(/showPersistentPill/);
    // 常驻状态来自服务端 /runtime,不再靠"本页见过它在跑"猜
    expect(header).toMatch(/api\.sessionRuntime\(/);
    expect(header).toMatch(/api\.releaseSessionRuntime\(/);
    expect(header).toMatch(/api\.prewarmSession\(/);

    const menu = read('../../main-content/view/subcomponents/SessionActionsMenu.tsx');
    for (const action of ['export', 'persistent', 'copy-path', 'delete']) {
      expect(menu).toContain(`'${action}'`);
    }
    expect(menu).toMatch(/data-main-menu/);

    const title = read('../../main-content/view/subcomponents/MainContentTitle.tsx');
    expect(title).toMatch(/data-main-title/);
    expect(title).toMatch(/data-main-project/);
    expect(title).toMatch(/data-main-title-rename/);
    expect(title).toMatch(/<Tooltip content=\{coordinates\} position="bottom"/);
  });

  it('对话区:时间轴抬头是纯文本行、行首是工具图标 + 状态配色 + 短连接线、回答 14/24', () => {
    const timeline = read('../view/subcomponents/ActivityTimeline.tsx');
    expect(timeline).toMatch(/data-activity-summary/);
    // ei:抬头不套白框 —— 一行次级墨色的纯文本,容器交给消息本身
    expect(timeline).not.toMatch(/rounded-panel border border-border bg-card/);
    expect(timeline).toMatch(/data-activity-summary[\s\S]{0,200}py-1\.5 text-left text-\[13px\] leading-5 text-muted-foreground/);
    expect(timeline).not.toMatch(/prism-rail-line/);
    expect(timeline).toMatch(/formatRunDuration/);
    // eh:行首图标回到工具类型(失败换 XCircle),状态只由颜色表达:紫 = 在跑
    expect(timeline).toMatch(/const Icon = summary\?\.status === 'error' \? XCircle : ICONS\[iconKey\];/);
    expect(timeline).toMatch(/summary\?\.status === 'running'\s*\?\s*'text-primary'\s*:\s*'text-muted-foreground'/);
    // eh:相邻两步之间挂连接线(最后一行不画),不是贯穿整段的长轨
    // ej:线由固定 10px 改成随行高伸缩 —— 展开一行之后线要跟到底,不能断在半路
    expect((timeline.match(/prism-activity-link min-h-\[10px\] w-px flex-1/g) ?? []).length).toBe(2);
    expect(timeline).toMatch(/\{!isLastRow && <span className="prism-activity-link/);

    const css = readFileSync(fileURLToPath(new URL('../../../index.css', import.meta.url)), 'utf8');
    expect(css).toMatch(/\.chat-answer\.chat-answer \{[\s\S]*?font-size: 14px;[\s\S]*?line-height: 24px;/);
  });

  it('ei:产出可看可下 —— 项目目录外的产出走会话产出通道(只读)', () => {
    const sidebar = read('../../code-editor/hooks/useEditorSidebar.ts');
    // 绝对路径 + 不在项目根内 → 挂 outputSessionId,编辑器改走产出通道
    expect(sidebar).toMatch(/outputSessionId = isAbsolute && !insideProject && activeSessionId/);

    const doc = read('../../code-editor/hooks/useCodeEditorDocument.ts');
    expect(doc).toMatch(/api\.sessionOutputText\(outputSessionId, filePath\)/);
    // 产出通道只读:保存必须在最前面就被挡掉
    expect(doc).toMatch(/if \(outputSessionId\) \{\s*return;/);
    expect(read('../../code-editor/view/CodeEditor.tsx')).toMatch(/canSave=\{!isDiffView && !file\.outputSessionId\}/);

    const panel = read('../view/subcomponents/ChatWorkPanel.tsx');
    expect(panel).toMatch(/api\.sessionOutputBlob\(String\(sessionId\), file\.path\)/);
    expect(read('../view/subcomponents/TurnOutputsCard.tsx')).toMatch(/api\.sessionOutputBlob\(sessionId, file\.path\)/);
  });

  it('eh:常驻状态查询用应用侧会话 id(会话行没有 id 列,写错就永远 404 → 永远显示未开)', () => {
    const server = readFileSync(fileURLToPath(new URL('../../../../server/index.js', import.meta.url)), 'utf8');
    const route = server.slice(server.indexOf("app.get('/api/providers/:provider/sessions/:sessionId/runtime'"));
    const body = route.slice(0, route.indexOf('app.post('));
    expect(body).toMatch(/canViewerSeeSession\(appSessionId, readRequestViewer\(req\)\)/);
    expect(body).not.toMatch(/canViewerSeeSession\(session\.id/);
  });

  it('eh:常驻会话有醒目标识,菜单打开时回查一次真实状态', () => {
    expect(read('../../main-content/view/subcomponents/MainContentTitle.tsx')).toMatch(/data-persistent-badge/);
    expect(read('../../main-content/view/subcomponents/MainContentHeader.tsx')).toMatch(/onOpen=\{\(\) => \{ if \(sessionId\) void refreshResident\(sessionId\); \}\}/);
  });

  it('eh:窗口没到头时,第一段工具流被切断 —— 这一轮不出产出卡(避免 2 → 5 跳数)', () => {
    const pane = read('../view/subcomponents/ChatMessagesPane.tsx');
    expect(pane).toMatch(/const windowStartsAtBeginning = !hasMoreMessages && visibleMessageCount >= chatMessages\.length;/);
    expect(pane).toMatch(/renderedIndex === 0 && !windowStartsAtBeginning/);
    expect(pane).toMatch(/extractTurnOutputsCached\(item, item\.messages/);
  });

  it('本轮产出卡在正文最下方、复制/重跑那一行之上(与 Cowork 一致)', () => {
    const pane = read('../view/subcomponents/ChatMessagesPane.tsx');
    expect(pane).toMatch(/extractTurnOutputs/);
    expect(pane).toMatch(/turnOutputs=\{turnOutputs\}/);
    // 卡片不再是消息外面的兄弟节点
    expect(pane).not.toMatch(/<TurnOutputsCard/);

    const message = read('../view/subcomponents/MessageComponent.tsx');
    const cardAt = message.indexOf('<TurnOutputsCard');
    const actionsAt = message.indexOf('shouldShowAssistantCopyControl && (');
    expect(cardAt).toBeGreaterThan(-1);
    expect(actionsAt).toBeGreaterThan(-1);
    expect(cardAt).toBeLessThan(actionsAt);
  });

  it('底栏发送是主色药丸 + 纸飞机(最窄档仍收成方钮)', () => {
    const composer = read('../view/subcomponents/ChatComposer.tsx');
    expect(composer).toMatch(/<SendHorizonalIcon className="h-4 w-4"/);
    expect(composer).not.toMatch(/ArrowUpIcon/);
    expect(composer).toMatch(/density === 'minimal' \? 'h-8 w-8 flex-none px-0' : 'h-8 flex-none px-3\.5'/);
  });

  it('能渲染的文件点开就是渲染结果:md / html 与 notebook 同一约定', () => {
    const editor = read('../../code-editor/view/CodeEditor.tsx');
    expect(editor).toMatch(/setMarkdownPreview\(isMarkdownFile\);/);
    expect(editor).toMatch(/setHtmlPreview\(isHtmlPreviewFile\);/);
    // 换文件要重置,不把上一份"我切到源码了"粘过来
    expect(editor).toMatch(/\}, \[file\.path, isMarkdownFile, isHtmlPreviewFile\]\);/);
  });

  it('侧栏搜索范围菜单 portal 到 body(避免被项目行盖住)', () => {
    const header = read('../../sidebar/view/subcomponents/SidebarHeader.tsx');
    expect(header).toMatch(/createPortal\(/);
    expect(header).toMatch(/data-sidebar-search-mode-menu/);
    expect(header).toMatch(/className="prism-modal-shadow fixed z-\[101\]/);
    expect(header).not.toMatch(/absolute left-0 top-full z-50 mt-1 w-44/);
  });

  it('工作面板是「进度 / 产出」,产出行末是预览眼睛(下载退到悬停)', () => {
    const panel = read('../view/subcomponents/ChatWorkPanel.tsx');
    expect(panel).toMatch(/workPanel\.progress/);
    expect(panel).toMatch(/workPanel\.outputsShort/);
    expect(panel).toMatch(/<Eye className="h-3\.5 w-3\.5"/);
    expect(panel).toMatch(/group-hover\/output:opacity-100/);
  });

  it('侧栏减重:模式下拉内嵌搜索框、分段按钮与实心大按钮撤掉、「+」进列表标题行、会话行一行', () => {
    const header = read('../../sidebar/view/subcomponents/SidebarHeader.tsx');
    expect(header).toMatch(/data-sidebar-search-mode-menu/);
    expect(header).toMatch(/data-sidebar-create-project/);
    expect(header).not.toMatch(/prism-action/);
    // 桌面块里不再渲染分段按钮(移动端保留)
    const desktop = header.slice(header.indexOf('className="hidden md:block"'), header.indexOf('className="p-3 pb-2 md:hidden"'));
    expect(desktop).not.toMatch(/searchModeSegments/);
    expect(desktop).toMatch(/searchWithMode/);
    const session = read('../../sidebar/view/subcomponents/SidebarSessionItem.tsx');
    const desktopRow = session.slice(session.indexOf('className="hidden md:block"'));
    expect(desktopRow).not.toMatch(/sessions\.messageCount', \{ defaultValue: '\{\{count\}\} 条', count: sessionView\.messageCount \}\)\]/);
    expect(desktopRow).toMatch(/flex w-full min-w-0 items-center gap-1\.5/);
  });

  it('弹层圆角走 panel 档、模态走 dialog 档、输入框聚焦只换描边', () => {
    expect(read('../../../shared/view/ui/Dialog.tsx')).toMatch(/rounded-dialog border border-border bg-popover/);
    expect(read('../../../shared/view/ui/ActionMenu.tsx')).toMatch(/rounded-panel border border-border bg-popover/);
    expect(read('../../../shared/view/SessionExportMenu.tsx')).toMatch(/rounded-panel border border-border bg-popover/);
    const input = read('../../../shared/view/ui/Input.tsx');
    expect(input).toMatch(/focus-visible:border-primary/);
    expect(input).not.toMatch(/focus-visible:ring-1/);
  });
});
