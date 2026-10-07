#!/usr/bin/env node
/**
 * SDK / CLI 升级探针。每次升 SDK 先在容器里跑一遍,结果贴进部署文档。
 *
 *   node scripts/sdk-probe/run.mjs            # 全部场景
 *   node scripts/sdk-probe/run.mjs 5 7        # 只跑第 5、7 个
 *   PROBE_VERBOSE=1 …                         # 打出 CLI 的 stderr
 *
 * 不需要真网关与凭据:假网关(fake-gateway.mjs)在 127.0.0.1 上起,CLI 用 SDK 随包的那一份,
 * HOME 指到临时目录(不读任何人的 ~/.claude)。每个场景一个独立的 CLI 进程。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { startFakeGateway } from './fake-gateway.mjs';

const VERBOSE = process.env.PROBE_VERBOSE === '1';

function inputQueue() {
  const values = []; const waiters = []; let closed = false;
  return {
    push(v) { const w = waiters.shift(); if (w) w({ value: v, done: false }); else values.push(v); },
    close() { closed = true; while (waiters.length) waiters.shift()({ value: undefined, done: true }); },
    next() {
      if (values.length) return Promise.resolve({ value: values.shift(), done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((r) => waiters.push(r));
    },
    [Symbol.asyncIterator]() { return this; },
  };
}

/** 起一个常驻会话(streaming input),返回 { q, turn, frames, close, gw }。 */
async function openSession({ gatewayOptions = {}, env: extraEnv = {}, options = {}, homeDir } = {}) {
  const gw = gatewayOptions.gw ?? await startFakeGateway(gatewayOptions);
  const home = homeDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-probe-home-'));
  const cwd = options.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-probe-cwd-'));
  const env = {
    PATH: process.env.PATH, HOME: home,
    ANTHROPIC_BASE_URL: gw.url, ANTHROPIC_AUTH_TOKEN: 'probe',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1',
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const input = inputQueue();
  const frames = [];
  let waiter = null;
  const q = query({
    prompt: input,
    options: { cwd, env, settingSources: [], model: 'glm-5.3', ...options,
      stderr: (d) => { if (VERBOSE) process.stderr.write(d); } },
  });
  const reader = (async () => {
    for await (const m of q) {
      frames.push(m);
      if (m.type === 'result' && !m.parent_tool_use_id) waiter?.(m);
    }
  })().catch((e) => { if (VERBOSE) console.error('reader', e?.message); });
  const turn = (text, extra = {}) => {
    const uuid = crypto.randomUUID();
    const done = new Promise((resolve, reject) => {
      waiter = resolve;
      setTimeout(() => reject(new Error(`turn timeout: ${text}`)), 90_000).unref();
    });
    input.push({ type: 'user', uuid, session_id: '', parent_tool_use_id: null, priority: 'now',
      message: { role: 'user', content: [{ type: 'text', text }] }, ...extra });
    return done.then((result) => ({ uuid, result }));
  };
  const close = async () => { input.close(); try { q.close?.(); } catch { /* */ } await reader; if (!gatewayOptions.gw) await gw.close(); };
  return { q, turn, frames, close, gw, home, cwd, env };
}

const initOf = (frames) => frames.filter((f) => f.type === 'system' && f.subtype === 'init').at(-1);
const messageRequests = (gw) => gw.requests.filter((r) => r.path === '/v1/messages');

const scenarios = [];
const scenario = (id, title, fn) => scenarios.push({ id, title, fn });

scenario(1, '默认档位不传 permissionMode → init 报 default,Bash 走 canUseTool', async () => {
  let asked = null;
  const s = await openSession({
    gatewayOptions: { script: (body) => {
      // 2.1.285 会在 messages 末尾追加一条 system 角色的提醒,不能只看最后一条;
      // `echo` 这类只读命令 CLI 直接放行不问 —— 用一条会写盘的命令。
      const seenResult = JSON.stringify(body.messages).includes('"tool_result"');
      return seenResult ? { text: 'done' } : { toolUse: { name: 'Bash', input: { command: 'touch probe-written.txt', description: 'probe' } } };
    } },
    options: { canUseTool: async (toolName, input) => { asked = toolName; return { behavior: 'deny', message: 'probe denies' }; } },
  });
  try {
    await s.turn('run bash');
    const init = initOf(s.frames);
    return { ok: init?.permissionMode === 'default' && asked === 'Bash', detail: `init.permissionMode=${init?.permissionMode} · canUseTool 问到=${asked}` };
  } finally { await s.close(); }
});

scenario(2, '工具清单:禁掉 SendMessage/ListAgents 后不在;开 TODO_TOOLS 后有 TaskCreate(不开时对网关模型名没有)', async () => {
  const bare = await openSession({ options: {} });
  const hardened = await openSession({ env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }, options: { disallowedTools: ['SendMessage', 'ListAgents'] } });
  try {
    await bare.turn('hi'); await hardened.turn('hi');
    const b = initOf(bare.frames)?.tools ?? []; const h = initOf(hardened.frames)?.tools ?? [];
    const ok = !h.includes('SendMessage') && !h.includes('ListAgents') && h.includes('TaskCreate') && !b.includes('TaskCreate');
    return { ok, detail: `默认:SendMessage=${b.includes('SendMessage')} ListAgents=${b.includes('ListAgents')} TaskCreate=${b.includes('TaskCreate')} · 加固后:SendMessage=${h.includes('SendMessage')} ListAgents=${h.includes('ListAgents')} TaskCreate=${h.includes('TaskCreate')}` };
  } finally { await bare.close(); await hardened.close(); }
});

scenario(3, 'setModel 切任意网关模型名 → 下一轮按新名字发;网关拒绝时 setModel 报错', async () => {
  const s = await openSession({ gatewayOptions: { script: (body) => (body.model === 'no-such-model' ? { status: 400, message: 'unknown model' } : { text: 'ok' }) } });
  try {
    await s.turn('one');
    await s.q.setModel('kimi-k3');
    await s.turn('two');
    let rejected = null;
    try { await s.q.setModel('no-such-model'); } catch (e) { rejected = e?.message || String(e); }
    const models = messageRequests(s.gw).map((r) => r.body?.model);
    const ok = models.includes('kimi-k3') && models.at(-1) !== undefined;
    return { ok, detail: `请求模型序列 ${[...new Set(models)].join(' → ')} · 切到网关不认的名字:${rejected ? `被拒(${rejected.slice(0, 80)})` : '没被拒(CLI 接受了)'}` };
  } finally { await s.close(); }
});

scenario(4, 'resume:新版续旧 transcript / 旧版续新 transcript(需 PROBE_OLD_CLI 指到旧版 claude)', async () => {
  const oldCli = process.env.PROBE_OLD_CLI;
  const gw = await startFakeGateway();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-probe-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-probe-cwd-'));
  const count = (s) => messageRequests(gw).at(-1)?.body?.messages?.length ?? 0;
  try {
    const a = await openSession({ gatewayOptions: { gw }, homeDir: home, options: { cwd, ...(oldCli ? { pathToClaudeCodeExecutable: oldCli } : {}) } });
    const { result } = await a.turn('first'); await a.turn('second'); await a.close();
    const b = await openSession({ gatewayOptions: { gw }, homeDir: home, options: { cwd, resume: result.session_id } });
    const { result: newResult } = await b.turn('third'); const afterResume = count(b); await b.close();
    if (!oldCli) {
      return { ok: afterResume >= 5, detail: `新版写 → 新版续(未给 PROBE_OLD_CLI,跨版本没跑):续上后第一次请求带 ${afterResume} 条消息(期望 ≥5)` };
    }
    // 回滚方向:新版写过的 transcript 交给旧版续
    const c = await openSession({ gatewayOptions: { gw }, homeDir: home, options: { cwd, resume: newResult.session_id, pathToClaudeCodeExecutable: oldCli } });
    await c.turn('fourth'); const afterRollback = count(c); await c.close();
    return { ok: afterResume >= 5 && afterRollback >= afterResume + 2,
      detail: `旧版写 → 新版续:${afterResume} 条 · 新版写 → 旧版续(回滚方向):${afterRollback} 条(期望递增)` };
  } finally { await gw.close(); }
});

scenario(5, 'CLAUDE_CODE_MAX_CONTEXT_TOKENS:对网关模型名生效,对 claude-* 型号名不生效', async () => {
  const s = await openSession({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '128000' } });
  try {
    await s.turn('hi');
    const glm = await s.q.getContextUsage({ detail: 'summary' });
    await s.q.setModel('claude-sonnet-4-6');
    const claude = await s.q.getContextUsage({ detail: 'summary' });
    return { ok: glm.maxTokens === 128000 && claude.maxTokens !== 128000,
      detail: `glm-5.3 分母 ${glm.maxTokens}(阈 ${glm.autoCompactThreshold}) · claude-sonnet-4-6 分母 ${claude.maxTokens}` };
  } finally { await s.close(); }
});

scenario(6, 'getContextUsage:summary 不打 count_tokens,full 打', async () => {
  const s = await openSession();
  try {
    await s.turn('hi');
    const before = s.gw.requests.filter((r) => r.path.includes('count_tokens')).length;
    await s.q.getContextUsage({ detail: 'summary' });
    const afterSummary = s.gw.requests.filter((r) => r.path.includes('count_tokens')).length;
    await s.q.getContextUsage();
    const afterFull = s.gw.requests.filter((r) => r.path.includes('count_tokens')).length;
    return { ok: afterSummary === before && afterFull > afterSummary, detail: `summary 多打 ${afterSummary - before} 次 · full 多打 ${afterFull - afterSummary} 次` };
  } finally { await s.close(); }
});

scenario(7, 'autoCompactWindow:启动时给的生效(与 claude-* 取小);运行中 applyFlagSettings 改了不生效', async () => {
  const s = await openSession({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' }, options: { settings: { autoCompactWindow: 128000 } } });
  try {
    await s.turn('hi');
    const spawn = await s.q.getContextUsage({ detail: 'summary' });
    await s.q.applyFlagSettings({ autoCompactWindow: 256000 });
    await s.turn('again');
    const live = await s.q.getContextUsage({ detail: 'summary' });
    await s.q.setModel('claude-sonnet-4-6');
    const claude = await s.q.getContextUsage({ detail: 'summary' });
    const ok = spawn.maxTokens === 128000 && live.maxTokens === 128000 && claude.maxTokens === 128000;
    return { ok, detail: `启动时 128000 → 分母 ${spawn.maxTokens} · 运行中改 256000 → 分母 ${live.maxTokens}(不变 = 只认启动值) · 切 claude-sonnet-4-6 → ${claude.maxTokens}` };
  } finally { await s.close(); }
});

scenario(8, 'result 回显 user_message_uuid(普通回合与 /context /compact 本地命令)', async () => {
  const s = await openSession();
  try {
    const checks = [];
    for (const text of ['hello', '/context', '/compact', 'after']) {
      const { uuid, result } = await s.turn(text);
      checks.push({ text, echoed: result.user_message_uuid === uuid || (result.user_message_uuids ?? []).includes(uuid), numTurns: result.num_turns, local: result.local_command ?? null });
    }
    return { ok: checks.every((c) => c.echoed), detail: checks.map((c) => `${c.text}:${c.echoed ? '回显' : '没回显'}/num_turns=${c.numTurns}${c.local ? `/local=${c.local}` : ''}`).join(' · ') };
  } finally { await s.close(); }
});

scenario(9, '换窗口 = resume 重建:新进程按新窗口算、历史接得上', async () => {
  const gw = await startFakeGateway();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-probe-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-probe-cwd-'));
  try {
    const a = await openSession({ gatewayOptions: { gw }, homeDir: home, env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '128000' }, options: { cwd } });
    const { result } = await a.turn('first'); await a.turn('second');
    const before = await a.q.getContextUsage({ detail: 'summary' }); await a.close();
    const b = await openSession({ gatewayOptions: { gw }, homeDir: home, env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '256000' }, options: { cwd, resume: result.session_id, model: 'kimi-k3' } });
    await b.turn('third');
    const after = await b.q.getContextUsage({ detail: 'summary' });
    const carried = messageRequests(gw).at(-1)?.body?.messages?.length ?? 0;
    await b.close();
    return { ok: before.maxTokens === 128000 && after.maxTokens === 256000 && carried >= 5,
      detail: `重建前分母 ${before.maxTokens} → 重建后 ${after.maxTokens} · 重建后第一次请求带 ${carried} 条消息` };
  } finally { await gw.close(); }
});

const wanted = process.argv.slice(2).map(Number).filter(Number.isFinite);
const run = wanted.length ? scenarios.filter((s) => wanted.includes(s.id)) : scenarios;
const sdkVersion = JSON.parse(fs.readFileSync(new URL('../../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8')).version;
console.log(`# SDK 探针 · @anthropic-ai/claude-agent-sdk ${sdkVersion} · ${new Date().toISOString()}\n`);
let failed = 0;
for (const s of run) {
  const started = Date.now();
  let outcome;
  try { outcome = await s.fn(); } catch (e) { outcome = { ok: false, detail: `异常:${e?.message || e}` }; }
  if (!outcome.ok) failed += 1;
  console.log(`${outcome.ok ? '✔' : '✘'} ${s.id}. ${s.title}\n    ${outcome.detail}  (${Math.round((Date.now() - started) / 1000)}s)`);
}
console.log(`\n${run.length - failed}/${run.length} 通过`);
process.exit(failed ? 1 : 0);
