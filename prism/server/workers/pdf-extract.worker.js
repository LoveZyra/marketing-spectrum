/**
 * pdf-extract.worker.js — 在 worker_thread 里跑 pdf.js 抽文本,这样一个恶意或者
 * 畸形的 PDF(深层 xref 链、解压炸弹、病态内容流)卡不住主事件循环。父进程
 * (server/routes/documents.js)压着一个硬超时(PRISM_PDF_TIMEOUT_MS,默认 30s),
 * 到点直接 worker.terminate() —— 这是唯一能可靠打断 CPU 密集解析的办法,
 * 在主线程上做不到。
 *
 * 用 pdfjs-dist 而不是 pdf-parse:后者打包的是 2018 年的 pdf.js v1.10.100,
 * 实测读不了 reportlab 生成的 PDF(一律 `bad XRef entry`),而 reportlab 是各类
 * 系统开发票、出报表的常用生成器。换成维护中的 pdf.js 之后,同一批样本
 * (reportlab 四种变体、手写残缺 PDF、LibreOffice、Chromium)全部能读。
 *
 * 位置说明:这个文件放在 server/workers/ 下,是因为 server/tsconfig.json 用
 * allowJs 收了 ./**\/*.js 且 outDir=../dist-server,所以它会被输出到
 * dist-server/server/workers/,dist-server/server/routes/documents.js 里那个
 * "../workers/..." 的相对 URL 构建后依然解析得到。
 *
 * 协议:
 *   入参 (workerData): ArrayBuffer,PDF 原始字节(转移,不复制)
 *   出参 (postMessage): { ok: true, text: string, numpages: number|null }
 *                     | { ok: false, error: string }
 *   text 里页与页之间用 \f 分隔 —— 父进程按 \f 切出 [Page N] 标题。
 */

import { parentPort, workerData } from 'node:worker_threads';

/** 页数上限:超出的部分不再抽,避免几千页的文档把 30s 预算耗光却什么都没产出。 */
const MAX_PAGES = Number.parseInt(process.env.PRISM_PDF_MAX_PAGES || '', 10) > 0
  ? Number.parseInt(process.env.PRISM_PDF_MAX_PAGES, 10)
  : 500;

/**
 * 把 pdf.js 的内部异常翻成用户看得懂的一句话。
 *
 * 直接把 `bad XRef entry` 这种话甩给用户是没有意义的 —— 它既不说明发生了什么,
 * 也不提示能怎么办。认得出的几类单独给话,认不出的才回落到原始信息。
 */
export function describeFailure(error) {
  const name = error?.name || '';
  const message = String(error?.message || error || 'unknown error');
  if (name === 'PasswordException' || /password/i.test(message)) {
    return '这个 PDF 有密码保护,需要先解除加密再上传';
  }
  if (name === 'InvalidPDFException' || /invalid pdf/i.test(message)) {
    return '这个文件不是有效的 PDF,或者已经损坏';
  }
  if (/encrypt/i.test(message)) {
    return '这个 PDF 被加密了,无法读取正文';
  }
  return message;
}

/**
 * 一页的文字。`hasEOL` 是 pdf.js 给出的换行标记 —— 不看它就会把整页的文字片段
 * 拼成一行,句子和句子之间连空格都没有。
 */
export function readPageText(items) {
  let out = '';
  for (const item of items) {
    if (typeof item.str === 'string') out += item.str;
    if (item.hasEOL) out += '\n';
  }
  return out;
}

async function run() {
  let task = null;
  try {
    if (!(workerData instanceof ArrayBuffer) && !ArrayBuffer.isView(workerData)) {
      throw new Error('worker expected PDF bytes as an ArrayBuffer');
    }
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

    task = pdfjs.getDocument({
      data: new Uint8Array(workerData),
      // 解析不需要执行 PDF 里的 JavaScript,关掉。
      isEvalSupported: false,
      // 不去碰宿主的字体配置 —— 容器里通常压根没有 fontconfig。
      useSystemFonts: false,
      disableFontFace: true,
      // 只留错误级日志,免得每份文档都往服务端日志里刷一堆字体警告。
      verbosity: 0,
    });

    const doc = await task.promise;
    const pageCount = doc.numPages;
    const limit = Math.min(pageCount, MAX_PAGES);

    const pages = [];
    for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(readPageText(content.items));
      page.cleanup();
    }

    parentPort.postMessage({
      ok: true,
      text: pages.join('\f'),
      numpages: Number.isFinite(pageCount) ? pageCount : null,
    });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: describeFailure(error) });
  } finally {
    if (task) await task.destroy().catch(() => {});
  }
}

// 只有真的作为 worker 被起来时才跑;被测试直接 import 时 parentPort 是 null,
// 那时这个模块只是几个纯函数的容器。
if (parentPort) {
  run();
}
