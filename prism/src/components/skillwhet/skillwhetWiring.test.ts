import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 技能优化接线:客户端测试跑在 node 环境(没有 DOM 挂不起组件),读源码钉住
 * 「没挂载就不画、挂载了在定时任务之后」「反馈控件真的接进了消息卡」「调查卡三种落库
 * 形状」这几根线;真正的行为在服务端路由测试(message-feedback-routes / skillwhet-authz)。
 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('轨位与顶部标签', () => {
  it('轨上那一格在 tasks 之后、shell 之前,且按 useSkillWhetEnabled 过滤', () => {
    const rail = read('../app/AppRail.tsx');
    const tasksAt = rail.indexOf("id: 'tasks'");
    const skillAt = rail.indexOf("id: 'skillwhet'");
    const shellAt = rail.indexOf("id: 'shell'");
    expect(tasksAt).toBeGreaterThan(-1);
    expect(skillAt).toBeGreaterThan(tasksAt);
    expect(shellAt).toBeGreaterThan(skillAt);
    expect(rail).toMatch(/const skillWhetEnabled = useSkillWhetEnabled\(\);/);
    expect(rail).toMatch(/RAIL_TABS\.filter\(\(tab\) => tab\.id !== 'skillwhet' \|\| skillWhetEnabled\)/);
    expect(rail).toMatch(/labelKey: 'tabs\.skillwhet', icon: Sparkles/);
  });

  it('移动端顶部标签同样过滤', () => {
    const switcher = read('../main-content/view/subcomponents/MainContentTabSwitcher.tsx');
    expect(switcher).toMatch(/BASE_TABS\.filter\(\(tab\) => tab\.id !== 'skillwhet' \|\| skillWhetEnabled\)/);
  });

  it('未知(还没拉到状态)按"没有"处理,免得先画后消失', () => {
    const hook = read('./hooks/useSkillWhetStatus.ts');
    expect(hook).toMatch(/return status\?\.enabled === true;/);
    expect(hook).toMatch(/if \(response\.status === 404\) return \{ enabled: false \};/);
  });

  it('MainContent 懒加载页面,无项目也能看', () => {
    const main = read('../main-content/view/MainContent.tsx');
    expect(main).toMatch(/const SkillWhetPage = lazy\(\(\) => import\('\.\.\/\.\.\/skillwhet\/SkillWhetPage'\)\);/);
    expect(main).toMatch(/if \(activeTab === 'skillwhet'\)/);
  });
});

describe('对话里的反馈入口', () => {
  it('消息卡接了调查卡与 👍/👎,调查卡只给非 bare 且服务端抽中的回合', () => {
    const component = read('../chat/view/subcomponents/MessageComponent.tsx');
    expect(component).toMatch(/import MessageFeedbackControl from '\.\/MessageFeedbackControl';/);
    expect(component).toMatch(/import SkillSurveyCard from '\.\/SkillSurveyCard';/);
    expect(component).toMatch(/!bare && skillSurvey && onFeedbackSubmit && typeof message\.id === 'string'/);
    expect(component).toMatch(/shouldShowAssistantCopyControl && onFeedbackSubmit && onFeedbackRemove/);
  });

  it('调查卡三种形状:选档 answered、跳过 dismissed、补充说明更新同一行', () => {
    const card = read('../chat/view/subcomponents/SkillSurveyCard.tsx');
    expect(card).toMatch(/\{ source: 'survey', verdict: value, skillHint: skill \}/);
    expect(card).toMatch(/\{ source: 'survey', status: 'dismissed', skillHint: skill \}/);
    expect(card).toMatch(/\{ source: 'survey', verdict, note: note\.trim\(\) \|\| null, skillHint: skill \}/);
  });

  it('👍 是一票;👎 展开表单;改票走同一个 upsert,撤回走 delete', () => {
    const control = read('../chat/view/subcomponents/MessageFeedbackControl.tsx');
    expect(control).toMatch(/\{ source: feedback\?\.source \?\? 'vote', verdict: 1, skillHint: skill \|\| skillHint \|\| null \}/);
    expect(control).toMatch(/source: feedback\?\.source \?\? 'vote', verdict: -1, category, note: note\.trim\(\) \|\| null,/);
    expect(control).toMatch(/if \(isUp\) \{ await onRemove\(messageId\); return; \}/);
    expect(control).toMatch(/const CATEGORIES: FeedbackCategory\[\] = \['wrong_result', 'not_as_asked', 'wrong_tool', 'too_slow', 'other'\];/);
  });

  it('👎 表单预填的 skill 从 Skill 工具帧读,工具行的 toolInput 是字符串也认', () => {
    const pane = read('../chat/view/subcomponents/ChatMessagesPane.tsx');
    expect(pane).toMatch(/item\.isToolUse && item\.toolName === 'Skill'/);
    expect(pane).toMatch(/JSON\.parse\(item\.toolInput\)/);
  });

  it('work-frames 里的 skillSurveys 进了 hook,并随会话切换清空', () => {
    const hook = read('../chat/hooks/useSessionWorkFrames.ts');
    expect(hook).toMatch(/skillSurveys: ReadonlyMap<string, string>/);
    expect(hook).toMatch(/body\?\.data\?\.skillSurveys/);
  });

  it('「技能效果询问」开关挂在我的账号,写的是账号同步的 uiPreferences.skillSurveyEnabled', () => {
    const tab = read('../settings/view/tabs/AccountSettingsTab.tsx');
    expect(tab).toMatch(/<SkillSurveyToggleCard \/>/);
    const toggle = read('../settings/view/tabs/SkillSurveyToggleCard.tsx');
    expect(toggle).toMatch(/setPreference\('skillSurveyEnabled', !on\)/);
    expect(toggle).toMatch(/if \(!enabled\) return null;/);
    const prefs = read('../../hooks/useUiPreferences.ts');
    expect(prefs).toMatch(/skillSurveyEnabled: true,/);
    const synced = read('../../utils/accountSettings.ts');
    expect(synced).toMatch(/'uiPreferences',/);
  });
});

describe('技能优化页', () => {
  it('七项子导航全部接真数据;运行页在 openJob 时切成详情,跨页跳转带 skill / staging', () => {
    const page = read('./SkillWhetPage.tsx');
    for (const id of ['overview', 'runs', 'assets', 'tasks', 'wiki', 'eval', 'versions']) {
      expect(page, id).toMatch(new RegExp(`id: '${id}'`));
    }
    expect(page).not.toMatch(/ComingSoon/);
    expect(page).toMatch(/section === 'runs' && \(openJob\s*\? <RunDetail key=\{openJob\} jobId=\{openJob\}/);
    expect(page).toMatch(/<Runs data=\{data\} isRoot=\{isRoot\} username=\{username\} userId=\{userId\} initialSkill=\{runSkill\}/);
    expect(page).toMatch(/<Evaluation data=\{data\} onOpenVersions=\{goVersions\} \/>/);
    expect(page).toMatch(/<Versions data=\{data\} isRoot=\{isRoot\} username=\{username\} initialSkill=\{versionTarget\.skill\} initialStaging=\{versionTarget\.staging\} \/>/);
    expect(page).toMatch(/const userId = typeof user\?\.id === 'number' \? user\.id : null;/);
  });

  it('技能卡的按钮按权限分层,与服务端 assertMayMutate 一致', () => {
    const card = read('./view/SkillCard.tsx');
    expect(card).toMatch(/const mayMutate = isRoot \|\| \(skill\.source === 'upload' && skill\.uploaded_by === username\);/);
    expect(card).toMatch(/isRoot && skill\.source === 'live' && skill\.live_exists !== false/);
    expect(card).toMatch(/mayMutate && !skill\.bootstrapped/);
    // 「新建训练」权限同 mutate,且要先 bootstrap
    expect(card).toMatch(/onClick=\{\(\) => onTrain\(skill\.name\)\} disabled=\{busy !== null \|\| !skill\.bootstrapped\}/);
  });

  it('新建训练表单:非 root 不给 mock / 后端字段,评估模型 ≠ 提议模型,超额度不放行', () => {
    const form = read('./view/RunNew.tsx');
    expect(form).toMatch(/if \(mock && isRoot\) Object\.assign\(args, \{ fast_backend: 'mock', slow_backend: 'mock', eval_backend: 'mock' \}\);/);
    expect(form).toMatch(/run\.sameModel/);
    expect(form).toMatch(/run\.overBudget/);
    expect(form).toMatch(/run\.g1Fail/);
    expect(form).toMatch(/api\.skillWhet\.jobCreate\(/);
  });

  it('作业表:撤销只给发起人(tags user:<id>)或 root;3 秒轮询只在有活作业时', () => {
    const runs = read('./view/Runs.tsx');
    expect(runs).toMatch(/\(isRoot \|\| \(userId != null && job\.tags\?\.includes\(`user:\$\{userId\}`\)\)\)/);
    const hook = read('./hooks/useJobs.ts');
    expect(hook).toMatch(/const live = jobs\.some\(\(job\) => LIVE_STATES\.has\(job\.state\)\);/);
    expect(hook).toMatch(/window\.setInterval\(\(\) => void refresh\(\), 3_000\)/);
    expect(hook).toMatch(/api\.skillWhet\.jobProgress\(id, seqRef\.current\)/);
  });

  it('版本页:采纳权限同 mutate,未接受的要 force 二次确认;发布 / 回滚只画给 root 且发布要先采纳', () => {
    const versions = read('./view/Versions.tsx');
    expect(versions).toMatch(/const mayAdopt = Boolean\(target\) && \(isRoot \|\| \(target\?\.source === 'upload' && target\.uploaded_by === username\)\);/);
    // 没接受 → force;没做留出集评估 → skip_release;两个开关各带各的,test 上没变好也要二次确认
    expect(versions).toMatch(/force: !!s && !s\.accepted/);
    expect(versions).toMatch(/skipRelease: !!s && !s\.release/);
    expect(versions).toMatch(/g\.force \|\| g\.skipRelease \|\| g\.releaseWorse \? setConfirm\('adoptForce'\)/);
    expect(read('../../utils/api.js')).toMatch(/JSON\.stringify\(\{ force, skip_release: skipRelease \}\)/);
    // 轮询:4xx 停、连续失败停;留出集作业按 skill + staging 记
    expect(versions).toMatch(/res\.status >= 400 && res\.status < 500/);
    expect(versions).toMatch(/releaseJob\.skill === skill && releaseJob\.sid === selected/);
    const wizard = read('./view/HarvestWizard.tsx');
    expect(wizard).toMatch(/since: localMidnightIso\(since\)/);
    expect(wizard).toMatch(/disabled=\{running\}/);
    expect(versions).toMatch(/const canPublish = isRoot && latestAdopted;/);
    expect(versions).toMatch(/\{isRoot && \(\s*<>\s*<button type="button" onClick=\{\(\) => setConfirm\('publish'\)\}/);
    expect(versions).toMatch(/target\?\.source === 'upload' && \(\s*<button type="button" onClick=\{\(\) => setConfirm\('publishNew'\)\}/);
    expect(versions).toMatch(/\{isRoot && \(\s*typeof confirm === 'object' && confirm\?\.rollback === rb\.ts/);
  });

  it('任务集:从测试派生权限同入库;反馈收件箱只 root 拉、只 root 画', () => {
    const tasks = read('./view/Tasks.tsx');
    expect(tasks).toMatch(/target\?\.has_unit_tests && \(\s*<button type="button" onClick=\{\(\) => void derive\(\)\} disabled=\{!mayAdd \|\| busy !== null\}/);
    expect(tasks).toMatch(/if \(!isRoot\) return;\s*try \{\s*const res = await unwrap<\{ inbox: InboxRow\[\] \}>\(await api\.skillWhet\.feedbackInbox\(null\)\);/);
    expect(tasks).toMatch(/\{isRoot && \(\s*<section className="[^"]*" data-testid="tasks-inbox">/);
  });

  it('gz 审计回归:服务端复校认扁平报告;新建训练的 skill 永远在自己能训的名单里;进度轮询失败后退避重试', () => {
    const tasks = read('./view/Tasks.tsx');
    expect(tasks).toMatch(/const report = 'report' in result \? result\.report : result;/);
    const form = read('./view/RunNew.tsx');
    expect(form).toMatch(/if \(!skill \|\| !mine\.some\(\(s\) => s\.name === skill\)\) setSkill\(/);
    const hook = read('./hooks/useJobs.ts');
    expect(hook).toMatch(/const fresh = got\.filter\(\(e\) => e\.seq > have\);/);
    expect(hook).toMatch(/if \(live && failures < 20\) timer = window\.setTimeout/);
  });

  it('ha · 从会话挖只画给 root;留出集评估按钮只在没评过且未采纳时;体检按钮按 mutate 权限', () => {
    const tasks = read('./view/Tasks.tsx');
    expect(tasks).toMatch(/\{isRoot && skills\.length > 0 && <HarvestWizard skills=\{skills\} onImported=\{data\.refresh\} \/>\}/);
    const wizard = read('./view/HarvestWizard.tsx');
    expect(wizard).toMatch(/disabled=\{busy \|\| running \|\| stage !== 'listed' \|\| sessions\.length === 0\}/);
    expect(wizard).toMatch(/api\.skillWhet\.jobImport\(jobId, \[\.\.\.chosen\]\)/);
    const versions = read('./view/Versions.tsx');
    expect(versions).toMatch(/\{!current\.adopted && !current\.release && \(/);
    const card = read('./view/SkillCard.tsx');
    expect(card).toMatch(/onClick=\{recheck\} disabled=\{busy !== null \|\| !mayMutate\}/);
  });

  it('api.js 的作业 / staging / 发布 / 收件箱路径与服务端路由一致', () => {
    const api = read('../../utils/api.js');
    const routes = readFileSync(fileURLToPath(new URL('../../../server/modules/skillwhet/skillwhet.routes.ts', import.meta.url)), 'utf8');
    for (const [helper, route] of [
      ['jobCreate', "router.post('/jobs'"], ['jobBudget', "router.get('/jobs/budget'"], ['jobCancel', "router.post('/jobs/:id/cancel'"],
      ['jobProgress', "router.get('/jobs/:id/progress'"], ['jobLog', "router.get('/jobs/:id/log'"],
      ['stagingAdopt', "router.post('/skills/:name/staging/:sid/adopt'"], ['stagingExport', "router.get('/skills/:name/staging/:sid/export'"],
      ['publish', "router.post('/skills/:name/publish'"], ['publishAsNew', "router.post('/skills/:name/publish-as-new'"],
      ['rollback', "router.post('/skills/:name/rollback'"], ['tasksDerive', "router.post('/tasks/derive'"],
      ['feedbackInbox', "router.get('/feedback/inbox'"], ['feedbackInboxAccept', "router.post('/feedback/inbox/accept'"],
      ['harvestProjects', "router.get('/harvest/projects'"], ['harvestStart', "router.post('/harvest'"],
      ['jobResult', "router.get('/jobs/:id/result'"], ['jobImport', "router.post('/jobs/:id/import'"],
      ['releaseEval', "router.post('/skills/:name/staging/:sid/release-eval'"],
    ] as const) {
      expect(api, helper).toMatch(new RegExp(`\\b${helper}: `));
      expect(routes, route).toContain(route);
    }
  });

  it('任务集入库按钮:上传来源上传者可点,技能库来源只 root', () => {
    const tasks = read('./view/Tasks.tsx');
    expect(tasks).toMatch(/const mayAdd = Boolean\(target\) && \(isRoot \|\| \(target\?\.source === 'upload' && target\.uploaded_by === username\)\);/);
    expect(tasks).toMatch(/disabled=\{!canSubmit \|\| !mayAdd \|\| busy !== null\}/);
  });

  it('上传技能:任何登录用户都能点;载荷形状 { name, files:[{rel, content_b64}] }', () => {
    const assets = read('./view/Assets.tsx');
    expect(assets).toMatch(/onClick=\{\(\) => setUploadOpen\(true\)\}/);
    const lib = read('./lib/skill-upload.ts');
    expect(lib).toMatch(/encoded\.push\(\{ rel, content_b64: await readBase64\(file\) \}\);/);
    expect(lib).toMatch(/SKIP_DIRS = new Set\(\['\.git', 'node_modules', '__pycache__', '\.evo'/);
  });

  it('内部转录过滤:训练用的 prism-skillwhet 目录不当项目', () => {
    const markers = readFileSync(fileURLToPath(new URL('../../../server/shared/prism-internal-transcripts.ts', import.meta.url)), 'utf8');
    expect(markers).toMatch(/'prism-skillwhet'/);
  });
  it('导航回列表、runner 默认 / 提示、非训练作业不画训练页签、发布看副本采纳状态、挖任务只挖用过该 skill 的', () => {
    const page = read('./SkillWhetPage.tsx');
    expect(page).toMatch(/const goSection = \(id: SkillWhetSection\) => \{ if \(id === 'runs'\) setOpenJob\(null\); setSection\(id\); \};/);
    expect(page).not.toMatch(/onClick=\{\(\) => setSection\(id\)\}/);
    const runNew = read('./view/RunNew.tsx');
    expect(runNew).toMatch(/setRunner\(hasUnitTests \? 'pytest' : 'agent'\)/);
    expect(runNew).toMatch(/run\.pytestNoTests/);
    expect(runNew).toMatch(/tasks\.splits\.val < 3/);
    const detail = read('./view/RunDetail.tsx');
    expect(detail).toMatch(/const isTrain = \(job\.kind \?\? 'train'\) === 'train';/);
    expect(detail).toMatch(/\.\.\.\(isTrain \? \[/);
    const versions = read('./view/Versions.tsx');
    expect(versions).toMatch(/const latestAdopted = target\?\.adopted \?\? \(list\.length > 0 && list\[0\]\.adopted\);/);
    const wizard = read('./view/HarvestWizard.tsx');
    expect(wizard).toMatch(/skipped_other_skill/);
    expect(wizard).toMatch(/data-testid="harvest-none"/);
    const card = read('./view/SkillCard.tsx');
    expect(card).toMatch(/card\.gatePassSkipped/);
  });
  it('技能优化是全局页面:不渲染项目侧栏 / 项目页头;左轨开合按钮改管技能导航;导航按训练先后排序', () => {
    const app = readFileSync(fileURLToPath(new URL('../app/AppContent.tsx', import.meta.url)), 'utf8');
    // 侧栏开合由 sidebarOpenHere 表达(切页不写偏好);技能优化 / Notebook 页一律收起。
    expect(app).toMatch(/const isSidebarCollapsed = !isMobile && \(!sidebarOpenHere \|\| editorMaximized\s*\|\| activeTab === 'skillwhet' \|\| activeTab === 'notebook'\);/);
    const rail = readFileSync(fileURLToPath(new URL('../app/AppRail.tsx', import.meta.url)), 'utf8');
    expect(rail).toMatch(/const onSkillPage = activeTab === 'skillwhet';/);
    expect(rail).toMatch(/setPreference\('skillNavVisible', !preferences\.skillNavVisible\)/);
    const main = readFileSync(fileURLToPath(new URL('../main-content/view/MainContent.tsx', import.meta.url)), 'utf8');
    expect(main).toMatch(/\{activeTab === 'skillwhet' \|\| activeTab === 'notebook' \? \(isMobile && \(/);
    const page = read('./SkillWhetPage.tsx');
    const order = [...page.matchAll(/\{ id: '(\w+)', icon:/g)].map((m) => m[1]);
    expect(order).toEqual(['overview', 'assets', 'tasks', 'runs', 'eval', 'wiki', 'versions']);
    expect(page).toMatch(/const navOpen = preferences\.skillNavVisible !== false;/);
    expect(page).toMatch(/navOpen \? 'flex max-md:hidden' : 'hidden'/);
    const overview = read('./view/Overview.tsx');
    expect(overview).toMatch(/grid-cols-\[repeat\(auto-fill,minmax\(190px,1fr\)\)\]/);
    const runs = read('./view/Runs.tsx');
    expect(runs.indexOf('<RunNew ')).toBeLessThan(runs.indexOf('data-testid="runs-list-title"'));
    const strip = read('./view/StatusStrip.tsx');
    expect(strip).toMatch(/<Badge key=\{key\} tone=\{tone\} wrap>/);
  });

  it('版本页:staging 的 diff 按训练时的底比,发布 / 回滚有记录;优化过程按步骤展开', () => {
    const versions = read('./view/Versions.tsx');
    expect(versions).toMatch(/api\.skillWhet\.publishHistory\(/);
    expect(versions).toMatch(/data-testid="publish-history"/);
    expect(versions).toMatch(/base=\{[^}]*diff_base\}/);
    const run = read('./view/RunDetail.tsx');
    expect(run).toMatch(/<ProcessTimeline events=\{events\} live=\{live\} renderEvent=/);
    expect(run).toMatch(/base=\{[^}]*diff_base\}/);
    const diff = read('./view/DiffView.tsx');
    expect(diff).toMatch(/diff\.noneSince/);
    const jobs = read('./hooks/useJobs.ts');
    expect(jobs).toMatch(/if \(got\.length < 500\) break;/);
    const apiSrc = readFileSync(fileURLToPath(new URL('../../utils/api.js', import.meta.url)), 'utf8');
    expect(apiSrc).toMatch(/publishHistory: \(name\) => authenticatedFetch\(`\/api\/skillwhet\/skills\/\$\{encodeURIComponent\(name\)\}\/publishes`\)/);
  });

  it('he · 夜训:技能卡上的开关、训练页顶上的昨夜小结、总览趋势、Wiki 状态、续跑按钮,服务端起调度器', () => {
    const card = read('./view/SkillCard.tsx');
    expect(card).toMatch(/<NightlyControl skill=\{skill\} plan=\{nightly\.plans\.find\(\(p\) => p\.skill_name === skill\.name\)\}/);
    const control = read('./view/NightlyControl.tsx');
    expect(control).toMatch(/api\.skillWhet\.nightlySave\(skill\.name/);
    expect(control).toMatch(/\{isRoot && \(/);
    const runs = read('./view/Runs.tsx');
    expect(runs.indexOf('<NightlySummary data={data} />')).toBeLessThan(runs.indexOf('<RunNew '));
    const detail = read('./view/RunDetail.tsx');
    expect(detail).toMatch(/data-testid="resume-banner"/);
    expect(detail).toMatch(/api\.skillWhet\.jobResume\(jobId\)/);
    const overview = read('./view/Overview.tsx');
    expect(overview).toMatch(/<CostChart rows=\{daily\} \/>/);
    const wiki = read('./view/Wiki.tsx');
    expect(wiki).toMatch(/data-testid="wiki-filter"/);
    const page = read('./SkillWhetPage.tsx');
    expect(page).toMatch(/api\.skillWhet\.nightly\(\)/);
    const index = readFileSync(fileURLToPath(new URL('../../../server/index.js', import.meta.url)), 'utf8');
    // 启动步骤包在 runStartupStep(…, () => skillWhetNightly?.start(), log) 里,只认调用本身
    expect(index).toMatch(/skillWhetNightly\?\.start\(\)/);
    expect(index).toMatch(/skillWhetNightly\?\.stop\(\)/);
  });

  it('hf2 · 费用上限:超过 .env 上限不再悄悄压回 —— 非 root 拦住并说怎么改,root 可越过并提示审计;被钳的参数回给页面', () => {
    const form = read('./view/RunNew.tsx');
    expect(form).toMatch(/const costHard = isRoot \? \(budget\?\.hardMaxCostUsd \?\? costCap\) : costCap;/);
    expect(form).toMatch(/if \(costAsked > costHard\) \{/);
    expect(form).toMatch(/run\.rootOverCost/);
    expect(form).toMatch(/data\.clamped && data\.clamped\.length > 0/);
  });

  it('数字框能正常打字;Notebook 页不显示项目栏', () => {
    const form = read('./view/RunNew.tsx');
    expect(form).not.toMatch(/type="number"/);
    expect(form).toMatch(/<NumberInput integer min=\{1\} max=\{20\} value=\{rounds\}/);
    const nightly = read('./view/NightlyControl.tsx');
    expect(nightly).not.toMatch(/type="number"/);
    // 夜训轮数上限 / 单次费用上限都跟服务端给的走(20 / 100)
    expect(nightly).toMatch(/max=\{meta\.nightlyMaxRounds \?\? 10\}/);
    expect(nightly).toMatch(/meta\.nightlyHardMaxCostUsd \?\?/);
    const tasks = readFileSync(fileURLToPath(new URL('../tasks/TasksPage.tsx', import.meta.url)), 'utf8');
    expect(tasks).not.toMatch(/type="number"/);
    const rail = readFileSync(fileURLToPath(new URL('../app/AppRail.tsx', import.meta.url)), 'utf8');
    expect(rail).toMatch(/disabled=\{onNotebookPage\}/);
    const main = readFileSync(fileURLToPath(new URL('../main-content/view/MainContent.tsx', import.meta.url)), 'utf8');
    expect(main).toMatch(/if \(activeTab === 'notebook'\) \{\s*return \(/);
  });
});
