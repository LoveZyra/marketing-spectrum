import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import type { Archiver } from 'archiver';

/**
 * hk(审计 P1-7):zip 下载**按需打开文件、取消时全部关掉**。
 *
 * 原来用 `archive.directory()` / `archive.file()`:archiver 内部为条目开的读流,在客户端中途取消
 * (`archive.abort()`)之后不会被关掉 —— 探针里打包两个 300MB 文件、限速下载后断开,每断一次进程里
 * 就多一个永远不关的 fd,`finalize()` 也永不返回。取消得多了整个服务报 EMFILE。
 *
 * 现在自己走目录树,**一次只开一个文件**:append 一个条目、等 archiver 发 `entry`(它读完了)再开下一个;
 * 登记每一个打开的流,客户端断开时逐个 destroy。目录里的软链仍以链接条目存入(不带目标内容),与原来一致。
 */

export type ZipInputEntry = { absPath: string; entryName: string; isDirectory: boolean };

type WalkItem =
  | { kind: 'file'; absPath: string; name: string; stat: fs.Stats }
  | { kind: 'dir'; name: string; stat: fs.Stats }
  | { kind: 'link'; name: string; target: string };

async function* walk(absPath: string, name: string): AsyncGenerator<WalkItem> {
  let stat: fs.Stats;
  try {
    stat = await fsPromises.lstat(absPath);
  } catch {
    return; // 打包期间被删了:跳过这个条目,不让整个包失败
  }
  if (stat.isSymbolicLink()) {
    try {
      // 与原来 archiver.directory() 同口径:链接目标换算成相对链接所在目录的路径 ——
      // 直接写 readlink 的原串会把服务器上的绝对路径带进 zip,解压出来也是断链。
      const raw = await fsPromises.readlink(absPath);
      const dir = path.dirname(absPath);
      yield { kind: 'link', name, target: path.relative(dir, path.resolve(dir, raw)) };
    } catch {
      /* 读不到链接目标就跳过 */
    }
    return;
  }
  if (stat.isDirectory()) {
    yield { kind: 'dir', name, stat };
    let children: fs.Dirent[] = [];
    try {
      children = await fsPromises.readdir(absPath, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      yield* walk(path.join(absPath, child.name), `${name}/${child.name}`);
    }
    return;
  }
  if (stat.isFile()) {
    yield { kind: 'file', absPath, name, stat };
  }
  // 设备文件、FIFO 一律跳过:读起来会永久挂住整条连接。
}

export type ZipStreamHandle = {
  /** 客户端断开时调用:停止追加、abort archiver、关掉所有打开的读流。 */
  abort: () => void;
  /** 当前打开着的读流数(测试用)。 */
  openStreams: () => number;
  /** 追加完所有条目并 finalize 之后 resolve;被 abort 时也 resolve(不抛)。 */
  done: Promise<void>;
};

export function streamZipEntries(archive: Archiver, entries: ZipInputEntry[], onSkip?: (message: string) => void): ZipStreamHandle {
  const open = new Set<fs.ReadStream>();
  let aborted = false;
  // 当前在等的那一个条目的 resolve。abort 时直接叫醒它 —— 不要每个条目都挂一个 abort 回调:
  // 正常打包时那个 promise 永远不 resolve,回调全留在内存里(复核实测 20 万条目约 116MB)。
  let wakeCurrent: (() => void) | null = null;

  const abort = () => {
    if (aborted) return;
    aborted = true;
    try { archive.abort(); } catch { /* 已经结束 */ }
    for (const stream of open) stream.destroy();
    open.clear();
    const wake = wakeCurrent;
    wakeCurrent = null;
    wake?.();
  };

  /** 等 archiver 处理完刚追加的那个条目(或出错 / 被取消)。 */
  const nextEntry = () => new Promise<void>((resolve, reject) => {
    if (aborted) { resolve(); return; }
    const cleanup = () => {
      archive.off('entry', onEntry);
      archive.off('error', onError);
      wakeCurrent = null;
    };
    const onEntry = () => { cleanup(); resolve(); };
    const onError = (error: unknown) => { cleanup(); reject(error); };
    archive.on('entry', onEntry);
    archive.on('error', onError);
    wakeCurrent = () => { cleanup(); resolve(); };
  });

  const done = (async () => {
    for (const entry of entries) {
      const root = entry.entryName.replace(/\/+$/, '');
      for await (const item of walk(entry.absPath, root)) {
        if (aborted) return;
        if (item.kind === 'dir') {
          // `type: 'directory'` archiver 运行时认(core.js _normalizeEntryData),类型声明里没写。
          const dirData = { name: `${item.name}/`, type: 'directory', date: item.stat.mtime, mode: item.stat.mode };
          archive.append(Buffer.alloc(0), dirData as unknown as Parameters<Archiver['append']>[1]);
        } else if (item.kind === 'link') {
          archive.symlink(item.name, item.target, 0o777);
        } else {
          const stream = fs.createReadStream(item.absPath);
          open.add(stream);
          stream.on('close', () => open.delete(stream));
          stream.on('error', (error) => onSkip?.(`${item.name}: ${error.message}`));
          archive.append(stream, { name: item.name, date: item.stat.mtime, mode: item.stat.mode });
        }
        await nextEntry();
      }
    }
    if (aborted) return;
    await archive.finalize();
  })();

  return { abort, openStreams: () => open.size, done };
}

/** 同时在打包的 zip 下载上限。打包吃 CPU 和磁盘,十几个人同时下整个项目会把服务拖慢。 */
export const ZIP_MAX_CONCURRENT = (() => {
  const raw = Number.parseInt(process.env.PRISM_ZIP_MAX_CONCURRENT ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 4;
})();

let activeZips = 0;

/** hl(P3 文件组):签票时先看名额 —— 满了在 fetch 语境里就回 429,前端弹得出提示;不占名额。 */
export function hasZipSlot(): boolean {
  return activeZips < ZIP_MAX_CONCURRENT;
}

/** 占一个打包名额;满了返回 null。返回的函数释放名额(可重复调用,只减一次)。 */
export function acquireZipSlot(): (() => void) | null {
  if (activeZips >= ZIP_MAX_CONCURRENT) return null;
  activeZips += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeZips -= 1;
  };
}
