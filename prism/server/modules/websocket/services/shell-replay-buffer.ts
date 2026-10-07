/**
 * PTY 回放缓冲的字节预算裁剪(纯函数,便于单测)。
 *
 * 终端断线重连时,服务端把最近的一段输出回放给新 socket。单个 chunk 的大小不受控
 * (`cat` 一个大文件就能让一个 PTY 的缓冲挂住几十 MB),所以用字节为主、条数兜底的
 * 双预算:任一超限就从头部丢最老的。
 *
 * 就地修改传入的数组(与调用点的 session.buffer 语义一致),返回新的字节合计。
 */
export function pushReplayChunk(
  buffer: string[],
  bufferedBytes: number,
  chunk: string,
  maxBytes: number,
  maxChunks: number,
  byteLength: (text: string) => number,
): number {
  buffer.push(chunk);
  let total = bufferedBytes + byteLength(chunk);

  while (buffer.length > 0 && (total > maxBytes || buffer.length > maxChunks)) {
    const dropped = buffer.shift();
    if (dropped !== undefined) total -= byteLength(dropped);
  }

  // 单个 chunk 本身就超预算的极端情形:上面的循环会把它也丢掉(buffer 空、
  // total 归零),回放缓冲宁可空也不挂着一个巨块。钳到 0 防浮点/计数漂移。
  return total < 0 ? 0 : total;
}
