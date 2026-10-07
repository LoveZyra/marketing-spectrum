/**
 * 终端 id 前缀什么时候沿用 sessionStorage 里的旧值。
 *
 * 「复制标签页」会把 sessionStorage 一起复制过去,两个页签拿到同一个前缀就会命中同一个 PTY。
 * 所以只有刷新本页(navigation type = reload)才沿用旧前缀以连回自己的 PTY;其余一律新生成
 * (复制出来的页签在 Chrome 里报 back_forward / navigate,都不算)。
 */
export function decideShellTabPrefix(
  navigationType: string | null | undefined,
  stored: string | null | undefined,
  make: () => string,
): { prefix: string; reused: boolean } {
  if (navigationType === 'reload' && stored && /^[a-z0-9]{4,8}$/.test(stored)) {
    return { prefix: stored, reused: true };
  }
  return { prefix: make(), reused: false };
}

export function currentNavigationType(): string | null {
  try {
    const entry = performance.getEntriesByType?.('navigation')?.[0] as { type?: string } | undefined;
    return entry?.type ?? null;
  } catch {
    return null;
  }
}
