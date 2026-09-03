import { safeLocalStorage } from './chatStorage';
import type { ServerTurnOutputFile } from './turnOutputs';

/**
 * 「产出」卡的本地快照(ek)。
 *
 * ## 为什么要缓存
 *
 * 产出映射由服务端按全量历史算好(ej),但它走的是 work-frames 那一次请求 ——
 * **刷新页面时内存清空、请求还在路上,卡片就有一段空窗**:用户实测"一刷新产出
 * 文件的部分就会消失,然后等待重新加载完成"。这段空窗不是加载慢,是从零开始。
 *
 * 把上一次拿到的映射存下来,挂载时**同步**读回,首帧就有卡片;请求落地再整体
 * 替换。两份内容一致时用户什么也看不见 —— 这正是目的:卡片一直在那儿。
 *
 * ## 为什么不塞进消息接口
 *
 * 更"正统"的做法是让 `/messages` 一起下发。但那条接口是**分页**的热路径,
 * dn-O1 专门把它改成了 SQL 尾页、避开全量 parse;为了这张卡把全量 parse 加回
 * 每一页,等于用首屏时延换首帧观感,不划算。缓存只在浏览器里,零服务端代价。
 *
 * ## 边界
 *
 * 缓存是**加速**不是真相:请求落地一律以服务端为准(整体替换,不做合并),
 * 映射里没有的回合仍走前端窗口内现推的兜底。读写全部包在 try 里,存储被禁用、
 * 写满、内容损坏,都只是回到"没有缓存"的状态。
 */

const KEY = 'prism-turn-outputs-v1';
/** 每个会话最多存这么多回合 —— 只有最近的会被看到,老的翻上去也已经在窗口里了。 */
const MAX_TURNS_PER_SESSION = 120;
/** 同时保留几个会话的快照(按最近写入淘汰)。 */
const MAX_SESSIONS = 8;
/** 序列化后的硬上限,超了就丢掉最旧的会话再试。 */
const MAX_BYTES = 192 * 1024;

type Snapshot = { at: number; seq?: number; turns: Record<string, ServerTurnOutputFile[]> };
type Store = Record<string, Snapshot>;

/**
 * 淘汰用的单调序号。只靠 `Date.now()` 不够 —— 同一毫秒内写两次(切会话切得快、
 * 或测试里连着写)时间戳相同,排序就不稳定,淘汰会挑错人。序号只在本页有效,
 * 跨页时退回按时间戳排,那正是它够用的场景。
 */
let writeSeq = 0;

function readStore(): Store {
  const raw = safeLocalStorage.getItem(KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

/** 只留最后 N 个回合 —— 对象键序就是服务端算出来的时间序,直接切尾。 */
function trimTurns(turns: Record<string, ServerTurnOutputFile[]>): Record<string, ServerTurnOutputFile[]> {
  const keys = Object.keys(turns);
  if (keys.length <= MAX_TURNS_PER_SESSION) return turns;
  const kept: Record<string, ServerTurnOutputFile[]> = {};
  for (const key of keys.slice(-MAX_TURNS_PER_SESSION)) kept[key] = turns[key];
  return kept;
}

export function readCachedTurnOutputs(sessionId: string | null): Record<string, ServerTurnOutputFile[]> | null {
  if (!sessionId) return null;
  const snapshot = readStore()[sessionId];
  if (!snapshot || !snapshot.turns || typeof snapshot.turns !== 'object') return null;
  return snapshot.turns;
}

export function writeCachedTurnOutputs(
  sessionId: string | null,
  turns: Record<string, ServerTurnOutputFile[]>,
): void {
  if (!sessionId) return;
  try {
    const store = readStore();
    writeSeq += 1;
    store[sessionId] = { at: Date.now(), seq: writeSeq, turns: trimTurns(turns) };

    // 会话数与体积两道闸,都按"最旧的先走"。
    let entries = Object.entries(store).sort((a, b) => {
      const byTime = (b[1]?.at ?? 0) - (a[1]?.at ?? 0);
      return byTime !== 0 ? byTime : (b[1]?.seq ?? 0) - (a[1]?.seq ?? 0);
    });
    if (entries.length > MAX_SESSIONS) entries = entries.slice(0, MAX_SESSIONS);

    let serialized = JSON.stringify(Object.fromEntries(entries));
    while (serialized.length > MAX_BYTES && entries.length > 1) {
      entries = entries.slice(0, -1);
      serialized = JSON.stringify(Object.fromEntries(entries));
    }
    // 只剩当前这一个还超标 → 干脆不存,别把配额耗在一张卡上。
    if (serialized.length > MAX_BYTES) {
      safeLocalStorage.removeItem(KEY);
      return;
    }
    safeLocalStorage.setItem(KEY, serialized);
  } catch {
    /* 存不下就算了 —— 缓存是加速,不是功能 */
  }
}
