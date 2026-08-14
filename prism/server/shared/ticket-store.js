import crypto from 'crypto';

/**
 * 一次性票据的通用实现。
 *
 * WebSocket 升级票据和编辑器预览票据本来是两份逐字相同的代码:同一套
 * `Map<ticket, {…, expiresAt}>`、同一个惰性启动的清扫定时器、同一段 `unref()`
 * 说明、同一个"取出即删除"的消费语义。两份分别改过一次之后就开始漂 —— 一边
 * 的清扫间隔跟着 TTL 走,另一边写死了。
 *
 * 差异有三处,都做成参数:TTL、载荷形状、**以及是不是一次性**。
 *
 * 最后一条不能想当然。WS 票据取出即删除 —— 它出现在 URL 查询串里(WebSocket
 * 升级设不了 Authorization 头),而查询串会进代理日志和浏览器历史,用尽一次
 * 意味着日志里那份已经作废。**预览票据恰恰相反,必须可重复使用**:一次预览要
 * 加载文档本身再加上它引用的每一个资源,取出即删会让第一张图之后全部 401。
 * 合并这两份实现时如果没注意到这一点,坏的是编辑器预览里的图片和样式。
 */
export function createTicketStore({ ttlMs, sweepIntervalMs = ttlMs, singleUse = true }) {
  /** ticket(hex) -> { payload, expiresAt } */
  const tickets = new Map();
  let sweepTimer = null;

  function sweepExpired() {
    const now = Date.now();
    for (const [ticket, entry] of tickets) {
      if (entry.expiresAt <= now) {
        tickets.delete(ticket);
      }
    }
    if (tickets.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  function ensureSweeper() {
    if (sweepTimer) return;
    sweepTimer = setInterval(sweepExpired, sweepIntervalMs);
    // 定时器不应该让进程活着 —— 一个空闲实例不该因为等着扫过期票据而无法退出。
    sweepTimer.unref?.();
  }

  return {
    /** 签发一张票,返回票据串。 */
    issue(payload) {
      const ticket = crypto.randomBytes(32).toString('hex');
      tickets.set(ticket, { payload, expiresAt: Date.now() + ttlMs });
      ensureSweeper();
      return ticket;
    },

    /**
     * 取出一张票的载荷。`singleUse` 为真时命中即删除。
     *
     * 过期条目无论哪种模式都会被删掉 —— 清扫定时器可能已经因为票据清空而停掉,
     * 过期的那张不能因此复活。过期、不存在、`validate` 判否三种情况都返回 null,
     * 对外不可区分。
     */
    consume(ticket, validate) {
      if (typeof ticket !== 'string' || !ticket) return null;

      const entry = tickets.get(ticket);
      if (!entry) return null;

      const expired = entry.expiresAt <= Date.now();
      if (singleUse || expired) {
        tickets.delete(ticket);
      }

      if (expired) return null;
      if (validate && !validate(entry.payload)) return null;

      return entry.payload;
    },

    /** 仅供测试:当前未消费且未过期的票数。 */
    size() {
      sweepExpired();
      return tickets.size;
    },

    /** 仅供测试:清空并停掉清扫定时器。 */
    reset() {
      tickets.clear();
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
    },
  };
}
