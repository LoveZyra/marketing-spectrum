/**
 * pdf-extract.worker.js — runs pdf-parse inside a worker_thread so a hostile
 * or degenerate PDF (deeply nested xref chains, decompression bombs, pathological
 * content streams) cannot wedge the main event loop. The parent
 * (server/routes/documents.js) enforces a hard deadline (PRISM_PDF_TIMEOUT_MS,
 * default 30s) and calls worker.terminate() on expiry, which reliably kills any
 * CPU-bound parse — something that is impossible to interrupt on the main thread.
 *
 * Location note: this file lives under server/workers/ because server/tsconfig.json
 * includes "./**\/*.js" with allowJs+outDir=../dist-server, so it is emitted to
 * dist-server/server/workers/ and the relative "../workers/..." URL from
 * dist-server/server/routes/documents.js keeps resolving after the build.
 *
 * Protocol:
 *   input  (workerData): ArrayBuffer with the raw PDF bytes (transferred, not copied)
 *   output (postMessage): { ok: true, text: string, numpages: number|null }
 *                       | { ok: false, error: string }
 */

import { parentPort, workerData } from 'node:worker_threads';

async function run() {
  try {
    // Import the library implementation directly: pdf-parse's package index runs
    // debug code when it thinks it is the entry module, so the route already used
    // the lib path — keep that here.
    const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
    if (!(workerData instanceof ArrayBuffer) && !ArrayBuffer.isView(workerData)) {
      throw new Error('worker expected PDF bytes as an ArrayBuffer');
    }
    const buffer = Buffer.from(workerData);
    const result = await pdfParse(buffer);
    parentPort.postMessage({
      ok: true,
      text: result.text || '',
      numpages: Number.isFinite(result.numpages) ? result.numpages : null,
    });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
}

run();
