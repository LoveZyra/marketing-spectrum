/**
 * Document text extraction + URL article fetch (ported from claude-web-ui 2.0).
 *
 * POST /api/documents/parse       multipart upload -> { name, text, truncated }
 *   Supported: pdf, docx, pptx, xlsx/xlsm, csv/tsv, txt/md/json and other
 *   plain-text formats. Extracted text is attached to the chat prompt by the
 *   composer, so binary formats become model-readable.
 *
 * POST /api/documents/fetch-url   { url } -> { title, text, url, truncated }
 *   SSRF-guarded readable-text extraction of a public web page.
 *
 * Hardening notes:
 *   - fetch-url pins every connection to the DNS answers validated by the SSRF
 *     guard (per-hop http/https Agent with a custom `lookup`), so a hostname
 *     cannot re-resolve to a private address between check and connect
 *     (DNS-rebinding TOCTOU). Redirects stay manual; each hop re-validates and
 *     re-pins with a fresh agent. One overall deadline covers connect + headers
 *     + body (slow-loris safe).
 *   - zip-based formats (docx/pptx/xlsx/xlsm) are pre-scanned with JSZip and
 *     stream-inflated with byte counters before mammoth/xlsx see the buffer
 *     (zip-bomb caps: entries, per-entry, total uncompressed).
 *   - pdf-parse runs inside a worker_thread with a hard terminate() deadline.
 *   - plain text decoding: strict UTF-8 -> GB18030 -> Shift_JIS -> Latin-1.
 *
 * Env vars (all optional):
 *   PRISM_DOC_MAX_CHARS          per-document extracted text cap (default 200000)
 *   PRISM_URL_FETCH_TIMEOUT_MS   overall fetch-url deadline (default 20000)
 *   PRISM_PDF_TIMEOUT_MS         pdf-parse worker deadline (default 30000)
 *   PRISM_DOC_MAX_UNCOMPRESSED   total uncompressed zip cap in bytes (default 200MB)
 */

import crypto from 'crypto';
import dns from 'dns';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';
import { Worker } from 'worker_threads';

import nodeFetch from 'node-fetch';
import multer from 'multer';
import express from 'express';

import { isPrivateIp } from '../shared/ip-guard.js';

const router = express.Router();

/** Positive-integer env override with fallback. */
function intFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const MAX_DOC_BYTES = 20 * 1024 * 1024; // 20MB upload cap (/parse — buffered in memory)
// /land takes a much larger cap than /parse because the two do different work:
// /parse must hand a whole Buffer to mammoth/xlsx/pdf-parse, so its ceiling is
// bounded by RAM, while /land only relays bytes to disk and never materializes
// them in the heap. Keep MB and BYTES derived from one number so the cap and
// the error message can never drift apart.
const MAX_LAND_MB = 500;
const MAX_LAND_BYTES = MAX_LAND_MB * 1024 * 1024;
const MAX_TEXT_CHARS = intFromEnv('PRISM_DOC_MAX_CHARS', 200_000); // extracted text cap per document
const MAX_URL_BYTES = 2 * 1024 * 1024; // 2MB page cap
const MAX_REDIRECTS = 5;
// One overall deadline for fetch-url covering connect + headers + body across
// all redirect hops. The old code cleared its abort timer as soon as headers
// arrived, so a server that trickled the body forever (slow-loris) could hold
// the request open indefinitely.
const FETCH_TIMEOUT_MS = intFromEnv('PRISM_URL_FETCH_TIMEOUT_MS', 20_000);
const PDF_TIMEOUT_MS = intFromEnv('PRISM_PDF_TIMEOUT_MS', 30_000);
// Zip-bomb caps for docx/pptx/xlsx (all zip containers).
const MAX_ZIP_UNCOMPRESSED_BYTES = intFromEnv('PRISM_DOC_MAX_UNCOMPRESSED', 200 * 1024 * 1024);
const MAX_ZIP_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOC_BYTES, files: 1 },
});

/* ------------------------------------------------------------------ */
/*  File landing (staging dir — NOT publicly served)                    */
/* ------------------------------------------------------------------ */
// Two-step flow (option B): when a file is attached in the chat, land the
// original bytes in a STAGING directory (sibling of the /html-upload uploads
// dir, but NOT served by express.static, so it is not yet public) and surface
// the disk path to the agent via `text` (the chat composer passes `text`
// straight into the prompt). The agent then acts on the user's prompt: run
// /upload-html <path> to publish, or Read the path to analyze. The HTML attach
// button (via /parse) and the generic attach button (via /land) both use this.
// See ~/.claude/skills/upload-html.
const HTML_STAGING_DIR = path.join(os.homedir(), 'html-server', 'staging');
// Where multer streams an in-flight /land upload before it is named and moved
// into the staging dir. Deliberately a child of the staging dir rather than
// os.tmpdir(): that guarantees both paths share a filesystem, so landing a
// finished upload is an atomic rename instead of a 500MB copy, and it keeps the
// bytes off any tmpfs an operator may have mounted at /tmp. Dot-prefixed so the
// half-written files it holds stay out of globs over the staging dir.
const HTML_STAGING_INCOMING_DIR = path.join(HTML_STAGING_DIR, '.incoming');

// multer/busboy reads multipart filename params as latin1 by default, so a
// UTF-8 filename (e.g. Chinese) arrives as mojibake (each UTF-8 byte becomes a
// latin1 char in 0x80-0xFF). Re-interpret those bytes as UTF-8 to recover the
// real name. Safe for ASCII (unchanged) and already-correct Unicode (codepoints
// > 0xFF left alone); only re-decodes when the round-trip is lossless, so true
// single-byte latin1 names are not corrupted.
function fixFilename(name) {
  if (!name) return name;
  let needsFix = false;
  for (const ch of name) {
    const cp = ch.codePointAt(0);
    if (cp > 0xFF) return name; // already proper unicode — don't touch
    if (cp >= 0x80) needsFix = true;
  }
  if (!needsFix) return name;
  try {
    const buf = Buffer.from(name, 'latin1');
    const decoded = buf.toString('utf8');
    if (Buffer.from(decoded, 'utf8').equals(buf)) return decoded;
    return name;
  } catch {
    return name;
  }
}

// Lands any file (html or otherwise) to the staging dir FAITHFULLY: keep the
// original (fixFilename-recovered) name + an 8-hex prefix for uniqueness. No
// slugify here — naming for the public URL is the agent's job at publish time
// (upload.sh translates the name to English). Staging is not served, so a real
// (e.g. Chinese) name on disk is fine; Node fs handles UTF-8. Named landHtmlFile
// for historical reasons — it handles arbitrary file types.
function reserveStagedPath(originalname) {
  fs.mkdirSync(HTML_STAGING_DIR, { recursive: true });
  const safeName = path.basename(originalname || 'upload');
  const prefix = crypto.randomBytes(4).toString('hex');
  const filename = `${prefix}_${safeName}`;
  return { filename, diskPath: path.join(HTML_STAGING_DIR, filename) };
}

// Buffer variant — used by /parse, whose multer instance is memory-backed
// because the parsers downstream need the bytes in hand anyway.
function landHtmlFile(originalname, buffer) {
  const landed = reserveStagedPath(originalname);
  fs.writeFileSync(landed.diskPath, buffer);
  return landed;
}

// Path variant — used by /land, whose multer instance already streamed the
// upload to .incoming. Moving is a metadata operation on the common case, so a
// 500MB attachment costs the same as a 5KB one and never touches the heap.
function landStagedFile(originalname, tempPath) {
  const landed = reserveStagedPath(originalname);
  try {
    fs.renameSync(tempPath, landed.diskPath);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    // .incoming is a child of the staging dir, so a cross-device error means an
    // operator mounted one of them separately. copyFileSync moves the bytes in
    // the kernel rather than through a JS Buffer, so the memory profile holds.
    fs.copyFileSync(tempPath, landed.diskPath);
    fs.unlinkSync(tempPath);
  }
  return landed;
}

// Minimal: surface only the staged file's disk path to the agent. The user's
// chat message carries the intent (publish via upload.sh / analyze via Read);
// the agent acts on path + prompt. Keep this lean — no instructions, no skill
// text — so the prompt stays clean (user asked for only the path + their msg).
function buildHtmlUploadNotice(_originalname, landed) {
  return landed.diskPath;
}

/* ------------------------------------------------------------------ */
/*  Shared text hygiene                                                */
/* ------------------------------------------------------------------ */

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 422;
  return error;
}

/**
 * The chat composer wraps every extracted document in an
 * <attached-document ...> ... </attached-document> envelope when building the
 * model prompt. A document (or fetched web page) that itself contains the
 * literal closing tag "</attached-document" could terminate that envelope
 * early and smuggle text the model would read as instructions OUTSIDE the
 * attachment — a prompt-injection boundary break. Neutralize it by swapping
 * the '<' of any such closing tag for the visually equivalent fullwidth
 * '＜' (U+FF1C): the text stays human-readable but can no longer close the
 * envelope. Case-insensitive because HTML/XML tag matching is.
 */
export function escapeAttachedDocumentTags(text) {
  return String(text ?? '').replace(/<(?=\/attached-document)/gi, '＜');
}

function capText(text) {
  const cleaned = escapeAttachedDocumentTags(text || '')
    .replace(/\u00a0/g, '') // strip non-breaking spaces (pre-existing behavior)
    .trim();
  if (cleaned.length > MAX_TEXT_CHARS) {
    return { text: cleaned.slice(0, MAX_TEXT_CHARS), truncated: true };
  }
  return { text: cleaned, truncated: false };
}

/* ------------------------------------------------------------------ */
/*  Zip-bomb guard (docx / pptx / xlsx are all zip containers)          */
/* ------------------------------------------------------------------ */

function isZipBuffer(buffer) {
  // "PK" + one of the local-header / empty-archive / spanned signatures.
  return buffer.length >= 4
    && buffer[0] === 0x50 && buffer[1] === 0x4b
    && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);
}

/**
 * Count the actual inflated bytes of one JSZip entry, aborting the stream as
 * soon as a cap is crossed. Central-directory sizes can be forged: JSZip keeps
 * inflating past the declared size and only errors at the end (verified
 * against a zip whose size fields were patched), so a declared-size check
 * alone is NOT sufficient — this streamed count is the authoritative guard.
 */
function countInflatedBytes(entry, runningTotal) {
  return new Promise((resolve, reject) => {
    let stream;
    try {
      stream = entry.nodeStream('nodebuffer');
    } catch (error) {
      reject(validationError(`Corrupt archive entry "${entry.name}": ${error.message}`));
      return;
    }
    let entryBytes = 0;
    let total = runningTotal;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { stream.destroy(); } catch { /* already gone */ }
      reject(error);
    };
    stream.on('data', (chunk) => {
      entryBytes += chunk.length;
      total += chunk.length;
      if (entryBytes > MAX_ZIP_ENTRY_BYTES) {
        fail(validationError(
          `Archive entry "${entry.name}" inflates beyond the ${Math.floor(MAX_ZIP_ENTRY_BYTES / (1024 * 1024))}MB per-entry limit`,
        ));
      } else if (total > MAX_ZIP_UNCOMPRESSED_BYTES) {
        fail(validationError(
          `Archive inflates beyond the total uncompressed limit of ${MAX_ZIP_UNCOMPRESSED_BYTES} bytes`,
        ));
      }
    });
    stream.on('error', (error) => {
      // e.g. JSZip's "uncompressed data size mismatch" on forged headers.
      fail(validationError(`Corrupt archive entry "${entry.name}": ${error.message}`));
    });
    stream.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(total);
      }
    });
  });
}

/**
 * Pre-scan a zip container before handing the buffer to mammoth/xlsx/pptx
 * extraction. Two passes:
 *   1. central-directory declared sizes (cheap; rejects honest zip bombs like
 *      42.zip immediately without inflating anything), then
 *   2. streamed inflation with byte counters (authoritative; catches archives
 *      whose size fields lie — see countInflatedBytes).
 * Caps: MAX_ZIP_ENTRIES entries, MAX_ZIP_ENTRY_BYTES per entry,
 * MAX_ZIP_UNCOMPRESSED_BYTES total (PRISM_DOC_MAX_UNCOMPRESSED).
 */
async function assertZipSafe(buffer) {
  const { default: JSZip } = await import('jszip');
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    throw validationError(`Not a readable Office archive: ${error.message}`);
  }

  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw validationError(`Archive has too many entries (${entries.length} > ${MAX_ZIP_ENTRIES})`);
  }

  // Pass 1: declared sizes from the central directory. JSZip exposes them on
  // the internal CompressedObject (entry._data.uncompressedSize) after
  // loadAsync — verified at runtime against real docx/zip files. Treat any
  // missing/odd value as unknown and let pass 2 decide.
  let declaredTotal = 0;
  for (const entry of entries) {
    const declared = entry._data && Number(entry._data.uncompressedSize);
    if (Number.isFinite(declared) && declared >= 0) {
      if (declared > MAX_ZIP_ENTRY_BYTES) {
        throw validationError(
          `Archive entry "${entry.name}" declares ${declared} uncompressed bytes (limit ${MAX_ZIP_ENTRY_BYTES})`,
        );
      }
      declaredTotal += declared;
      if (declaredTotal > MAX_ZIP_UNCOMPRESSED_BYTES) {
        throw validationError(
          `Archive declares more than ${MAX_ZIP_UNCOMPRESSED_BYTES} total uncompressed bytes`,
        );
      }
    }
  }

  // Pass 2: actually inflate with counters (bounded by the caps themselves).
  let actualTotal = 0;
  for (const entry of entries) {
    actualTotal = await countInflatedBytes(entry, actualTotal);
  }
}

/* ------------------------------------------------------------------ */
/*  Extractors                                                         */
/* ------------------------------------------------------------------ */

// Emitted next to this file's compiled output: server/tsconfig.json includes
// ./**/*.js with allowJs, so server/workers/pdf-extract.worker.js lands in
// dist-server/server/workers/ and this relative URL resolves both when running
// from source (tsx) and from dist-server.
const PDF_WORKER_URL = new URL('../workers/pdf-extract.worker.js', import.meta.url);

/**
 * Run pdf-parse inside a worker_thread with a hard deadline. pdf-parse (pdf.js)
 * can spin the CPU indefinitely on hostile PDFs; on the main thread that would
 * freeze the whole server and could not be interrupted. worker.terminate()
 * kills the parse reliably. Protocol: {ok,text,numpages} | {ok:false,error}.
 */
function runPdfWorker(buffer) {
  return new Promise((resolve, reject) => {
    // Copy into a standalone ArrayBuffer so it can be transferred (multer's
    // buffer may be a view on a shared pool slab).
    const bytes = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(bytes).set(buffer);

    let worker;
    try {
      worker = new Worker(PDF_WORKER_URL, { workerData: bytes, transferList: [bytes] });
    } catch (error) {
      reject(validationError(`PDF worker failed to start: ${error.message}`));
      return;
    }

    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => {
      settle(reject, validationError(`PDF parsing timed out after ${PDF_TIMEOUT_MS}ms`));
    }, PDF_TIMEOUT_MS);

    worker.once('message', (msg) => {
      if (msg && msg.ok) {
        settle(resolve, { text: msg.text || '', numpages: msg.numpages ?? null });
      } else {
        settle(reject, validationError(`PDF parsing failed: ${(msg && msg.error) || 'unknown error'}`));
      }
    });
    worker.once('error', (error) => {
      settle(reject, validationError(`PDF parsing failed: ${error.message}`));
    });
    worker.once('exit', (code) => {
      if (!settled && code !== 0) {
        settle(reject, validationError(`PDF worker exited unexpectedly (code ${code})`));
      }
    });
  });
}

async function extractPdf(buffer) {
  const result = await runPdfWorker(buffer);
  const pages = (result.text || '').split('\f');
  const parts = pages.map((page, index) => {
    const body = page.trim();
    return body ? `[Page ${index + 1}]\n${body}` : '';
  }).filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n') : (result.text || '').trim();
}

async function extractDocx(buffer) {
  await assertZipSafe(buffer);
  const { default: mammoth } = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value || '';
}

// Small named-entity table for the regex HTML/XML pipelines below (no new
// deps). Numeric entities are handled separately; &amp; must stay last so
// double-encoded text ("&amp;lt;") decodes one level only.
const NAMED_ENTITIES = {
  lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
  times: '×', laquo: '«', raquo: '»', deg: '°', sect: '§',
  para: '¶', euro: '€', pound: '£', yen: '¥', cent: '¢', plusmn: '±',
};

function codePointToChar(codePoint, fallback) {
  // String.fromCodePoint throws on > 0x10FFFF and lone surrogates — a hostile
  // page must not be able to 500 the route with &#x110000;.
  if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return fallback;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return fallback;
  return String.fromCodePoint(codePoint);
}

export function decodeXmlEntities(value) {
  return String(value ?? '')
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (match, hex) => codePointToChar(parseInt(hex, 16), match))
    .replace(/&#(\d+);/g, (match, dec) => codePointToChar(parseInt(dec, 10), match))
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,8});/g, (match, name) => {
      const key = name.toLowerCase();
      if (key === 'amp') return match; // decoded last, below
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
    })
    .replace(/&amp;/gi, '&');
}

/** Pull visible text runs out of one slide/notes XML document. */
function pptxXmlToText(xml) {
  const paragraphs = [];
  for (const paragraphMatch of xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)) {
    const runs = [...paragraphMatch[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((match) => decodeXmlEntities(match[1]));
    const line = runs.join('').trim();
    if (line) paragraphs.push(line);
  }
  return paragraphs.join('\n');
}

async function extractPptx(buffer) {
  await assertZipSafe(buffer);
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);

  const slideNumber = (name, prefix) => {
    const match = name.match(new RegExp(`^ppt/${prefix}(\\d+)\\.xml$`));
    return match ? parseInt(match[1], 10) : null;
  };

  const slides = Object.keys(zip.files)
    .map((name) => ({ name, number: slideNumber(name, 'slides/slide') }))
    .filter((entry) => entry.number !== null)
    .sort((a, b) => a.number - b.number);

  const parts = [];
  for (const slide of slides) {
    const xml = await zip.files[slide.name].async('string');
    const body = pptxXmlToText(xml);
    const notesName = `ppt/notesSlides/notesSlide${slide.number}.xml`;
    let notes = '';
    if (zip.files[notesName]) {
      notes = pptxXmlToText(await zip.files[notesName].async('string'));
    }
    const chunk = [`[Slide ${slide.number}]`, body, notes ? `[Notes]\n${notes}` : '']
      .filter(Boolean).join('\n');
    parts.push(chunk);
  }
  return parts.join('\n\n');
}

async function extractXlsx(buffer) {
  // .xlsx/.xlsm are zip containers; legacy .xls is an OLE/CFB binary, so only
  // pre-scan when the bytes actually are a zip.
  if (isZipBuffer(buffer)) await assertZipSafe(buffer);
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const parts = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
    if (rows.length === 0) continue;
    const rendered = rows
      .map((row) => row.map((cell) => String(cell ?? '').trim()).join(' | '))
      .filter((line) => line.replace(/\|/g, '').trim())
      .join('\n');
    parts.push(`[Sheet: ${sheetName}]\n${rendered}`);
  }
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ */
/*  Plain-text decoding (TXT / CSV / TSV / MD / unknown extensions)     */
/* ------------------------------------------------------------------ */

/**
 * Raw binary sniff: only a NUL byte is a hard "this is not text" signal at the
 * byte level. The old heuristic counted high/control BYTES in the raw buffer,
 * which misclassified perfectly valid GB18030/Shift_JIS text (multi-byte lead
 * bytes land in 0x80-0xFE) — non-UTF-8 CJK files were rejected as binary.
 * Control-character density is now measured AFTER decoding (see
 * controlCharRatio) where legitimate legacy encodings no longer look "binary".
 */
export function looksBinary(buffer) {
  return buffer.includes(0);
}

function hasUtf16Bom(buffer) {
  return buffer.length >= 2
    && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff));
}

/** Ratio of control characters (C0 minus \t\n\v\f\r, DEL, C1) in decoded text. */
export function controlCharRatio(text) {
  if (!text) return 0;
  let controls = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if ((cp <= 0x08) || (cp >= 0x0e && cp <= 0x1f) || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      controls += 1;
    }
  }
  return controls / text.length;
}

/**
 * Decode a text buffer without assuming UTF-8. Strategy (Node 22 ships
 * full-ICU, so all these TextDecoder labels exist):
 *   - UTF-16 BOM -> decode as UTF-16 (a UTF-16 file is full of NULs, so it
 *     must be recognized before the binary sniff);
 *   - strip a UTF-8 BOM if present;
 *   - strict utf-8 (fatal) -> gb18030 (fatal) -> shift_jis (fatal) -> latin1.
 * The fatal flag makes each attempt reject cleanly instead of silently
 * emitting U+FFFD, so GB18030 Chinese text no longer round-trips into mojibake.
 * Returns { text, encoding }.
 */
export function decodeTextBuffer(buffer) {
  let body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(body), encoding: 'utf-16le' };
  }
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(body), encoding: 'utf-16be' };
  }
  // Strip UTF-8 BOM
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    body = body.subarray(3);
  }
  for (const encoding of ['utf-8', 'gb18030', 'shift_jis']) {
    try {
      return { text: new TextDecoder(encoding, { fatal: true }).decode(body), encoding };
    } catch {
      // try the next candidate
    }
  }
  return { text: new TextDecoder('latin1').decode(body), encoding: 'latin1' };
}

export function extractPlainText(buffer) {
  if (!hasUtf16Bom(buffer) && looksBinary(buffer)) {
    throw new Error('File appears to be binary and is not a supported document format');
  }
  const { text } = decodeTextBuffer(buffer);
  if (controlCharRatio(text) > 0.05) {
    throw new Error('File appears to be binary and is not a supported document format');
  }
  return text;
}

const EXTRACTORS = {
  '.pdf': extractPdf,
  '.docx': extractDocx,
  '.pptx': extractPptx,
  '.xlsx': extractXlsx,
  '.xlsm': extractXlsx,
  '.xls': extractXlsx,
  '.csv': (buffer) => extractPlainText(buffer),
  '.tsv': (buffer) => extractPlainText(buffer),
  '.html': (buffer) => extractPlainText(buffer),
  '.htm': (buffer) => extractPlainText(buffer),
};

router.post('/parse', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No document uploaded' });

    const name = fixFilename(req.file.originalname || 'document');
    const ext = path.extname(name).toLowerCase();

    // HTML attachments are staged, not parsed: land the original file in a
    // non-served staging dir and surface the disk path to the agent via `text`.
    // The agent decides what to do based on the user's prompt (publish via
    // /upload-html, or analyze via Read). File is NOT public until published.
    if (ext === '.html' || ext === '.htm') {
      const landed = landHtmlFile(name, req.file.buffer);
      const text = buildHtmlUploadNotice(name, landed);
      return res.json({
        name,
        ext,
        chars: text.length,
        truncated: false,
        text,
        // `text` is a disk path, not a document body. The composer keys off
        // this to concatenate it onto the prompt bare instead of wrapping it
        // in an <attached-document> envelope that would delimit nothing.
        kind: 'path',
        htmlPath: landed.diskPath,
      });
    }

    const extractor = EXTRACTORS[ext] || ((buffer) => extractPlainText(buffer));

    let raw;
    try {
      raw = await extractor(req.file.buffer);
    } catch (error) {
      return res.status(422).json({
        error: `Failed to extract text from ${name}: ${error.message}`,
      });
    }

    const { text, truncated } = capText(raw);
    if (!text) {
      return res.status(422).json({ error: `No extractable text found in ${name}` });
    }

    res.json({ name, ext: ext || null, chars: text.length, truncated, text, kind: 'text' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Land ANY attached file (any type) to the staging dir and surface its disk
// path to the agent via `text`. Used by the generic paperclip attach button.
// 500MB cap; the file is NOT public until the agent publishes it via /upload-html.
//
// Disk-backed, not memory-backed: nothing in this path ever inspects the bytes,
// so buffering them would pin MAX_LAND_BYTES of RSS per concurrent upload for no
// benefit — and Buffers live outside the V8 heap, so exhausting them gets the
// whole process OOM-killed rather than failing one request.
const landUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        fs.mkdirSync(HTML_STAGING_INCOMING_DIR, { recursive: true });
        cb(null, HTML_STAGING_INCOMING_DIR);
      } catch (error) {
        cb(error, '');
      }
    },
    // A neutral temp name: the real (fixFilename-recovered) name is only applied
    // once the upload has completed, so a half-written file is never mistakable
    // for a landed one.
    filename: (_req, _file, cb) => cb(null, `incoming_${crypto.randomBytes(8).toString('hex')}`),
  }),
  limits: { fileSize: MAX_LAND_BYTES, files: 1 },
});

router.post('/land', (req, res) => {
  // Invoked manually rather than as route middleware so a limit breach becomes
  // a JSON error the composer can display, instead of falling through to
  // express's default HTML error page.
  landUpload.single('document')(req, res, (uploadError) => {
    // multer unlinks what it wrote when it aborts, but discarding the temp file
    // unconditionally means a partial upload cannot survive any error path.
    const discardTempFile = () => {
      const tempPath = req.file?.path;
      if (tempPath) fs.promises.unlink(tempPath).catch(() => {});
    };

    if (uploadError) {
      discardTempFile();
      const code = uploadError?.code;
      if (code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File too large. Maximum size is ${MAX_LAND_MB}MB.` });
      }
      if (code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ error: 'Only one file can be attached at a time.' });
      }
      return res.status(500).json({ error: uploadError?.message || 'Upload failed' });
    }

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
      const name = fixFilename(req.file.originalname || 'file');
      const landed = landStagedFile(name, req.file.path);
      const text = buildHtmlUploadNotice(name, landed);
      // kind:'path' — `text` is the staged disk path; see the /parse .html branch.
      res.json({ name, chars: text.length, truncated: false, text, kind: 'path', diskPath: landed.diskPath });
    } catch (error) {
      discardTempFile();
      res.status(500).json({ error: error.message });
    }
  });
});

/* ------------------------------------------------------------------ */
/*  URL fetch (SSRF guarded)                                           */
/* ------------------------------------------------------------------ */

/**
 * Validate a URL for outbound fetching and return BOTH the parsed URL and the
 * exact addresses the SSRF check approved, so the connection can be pinned to
 * them. Every resolved address must be public (one private answer rejects the
 * whole set — a resolver mixing public and private answers is exactly the
 * rebinding/split-horizon shape we refuse to touch).
 */
async function resolvePublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw validationError('Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw validationError('Only http(s) URLs are allowed');
  }
  // URL.hostname keeps the brackets on IPv6 literals ("[::1]") — strip them
  // before net.isIP / the guard, otherwise a v6 literal slips past the literal
  // branch into a doomed DNS lookup.
  const hostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;

  const literal = net.isIP(hostname);
  if (literal) {
    if (isPrivateIp(hostname)) throw validationError('URL resolves to a private address');
    return { url: parsed, addresses: [{ address: hostname, family: literal }] };
  }

  let results = [];
  try {
    results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw validationError('URL hostname did not resolve');
  }
  if (results.length === 0) throw validationError('URL hostname did not resolve');
  for (const entry of results) {
    if (isPrivateIp(entry.address)) {
      throw validationError('URL resolves to a private address');
    }
  }
  return {
    url: parsed,
    addresses: results.map((entry) => ({ address: entry.address, family: entry.family })),
  };
}

/**
 * DNS-rebinding (TOCTOU) fix: the guard above validates what the hostname
 * resolves to, but a plain fetch() would then re-resolve the hostname itself —
 * an attacker-controlled DNS server can answer public first, private second.
 * This agent's `lookup` never touches DNS again: it hands net.connect ONLY the
 * addresses the guard just approved. The request URL is unchanged, so for
 * https the TLS layer still verifies the certificate against the original
 * hostname (SNI/servername come from the URL, not from the pinned IP).
 * One agent per hop; redirects re-validate AND re-pin with a fresh agent.
 */
function makePinnedAgent(parsedUrl, addresses) {
  const AgentCtor = parsedUrl.protocol === 'https:' ? https.Agent : http.Agent;
  const pinned = addresses.map(({ address, family }) => ({ address, family }));
  return new AgentCtor({
    keepAlive: false,
    maxSockets: 4,
    lookup(_hostname, options, callback) {
      // Node may ask with {all:true} (happy-eyeballs) or for a single answer.
      if (options && options.all) {
        callback(null, pinned);
      } else {
        callback(null, pinned[0].address, pinned[0].family);
      }
    },
  });
}

/**
 * Read a node-fetch (v2, Node Readable) body up to MAX_URL_BYTES. The overall
 * AbortController deadline also covers this phase: on abort node-fetch destroys
 * the stream with an AbortError, and the explicit listener below is a second
 * line of defense, so a slow-loris body cannot outlive the deadline.
 */
async function readCappedBody(response, signal) {
  const stream = response.body;
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.subarray(0, MAX_URL_BYTES);
  }
  const onAbort = () => {
    const abortError = new Error('The user aborted a request.');
    abortError.name = 'AbortError';
    stream.destroy(abortError);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      chunks.push(buf);
      if (total >= MAX_URL_BYTES) break; // early exit destroys the stream
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    try { stream.destroy(); } catch { /* already closed */ }
  }
  return Buffer.concat(chunks).subarray(0, MAX_URL_BYTES);
}

/** Decode a fetched body, honoring a declared charset, else the strict chain. */
function decodeBodyText(buffer, contentType) {
  const charsetMatch = /charset=["']?([\w.:-]+)/i.exec(contentType || '');
  if (charsetMatch) {
    try {
      return new TextDecoder(charsetMatch[1]).decode(buffer);
    } catch {
      // unknown/unsupported label — fall through to sniffing
    }
  }
  return decodeTextBuffer(buffer).text;
}

const CHROME_BLOCK_RE = /<(script|style|noscript|svg|iframe|form|nav|footer|header|aside|head)\b[\s\S]*?<\/\1\s*>/gi;

export function htmlToText(html) {
  let source = String(html ?? '').replace(/<!--[\s\S]*?-->/g, ' ');

  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title/i);
  const title = titleMatch ? decodeXmlEntities(titleMatch[1].replace(/\s+/g, ' ').trim()) : '';

  // Prefer semantic content containers: an <article> (longest one, when a page
  // has several) beats <main>, which beats <body>. Page chrome outside the
  // chosen container (nav bars, footers, cookie banners) drops out entirely.
  const pickContainer = (tag) => {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'gi');
    let best = null;
    for (const match of source.matchAll(re)) {
      if (best === null || match[1].length > best.length) best = match[1];
    }
    return best;
  };
  let body = pickContainer('article') ?? pickContainer('main') ?? pickContainer('body') ?? source;

  // Strip non-content blocks (with their contents) that survive inside the
  // chosen container. Backreference under /i keeps the close tag matched
  // case-insensitively; run twice so blocks revealed by an outer removal
  // (rare nesting) get a second chance.
  body = body.replace(CHROME_BLOCK_RE, ' ').replace(CHROME_BLOCK_RE, ' ');

  body = body
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');

  const text = decodeXmlEntities(body)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text };
}

router.post('/fetch-url', async (req, res) => {
  // One deadline for the whole operation: connect + headers + body, across all
  // redirect hops. Aborting the controller tears down the in-flight socket via
  // node-fetch and destroys any half-read body stream.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let agent = null;
  const dropAgent = () => {
    if (agent) {
      try { agent.destroy(); } catch { /* noop */ }
      agent = null;
    }
  };
  try {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!rawUrl) return res.status(400).json({ error: 'url is required' });

    let { url: currentUrl, addresses } = await resolvePublicUrl(rawUrl);
    let response = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      dropAgent();
      agent = makePinnedAgent(currentUrl, addresses);
      response = await nodeFetch(currentUrl.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        agent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Prism/1.0; +https://localhost)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) break;
        if (hop === MAX_REDIRECTS) {
          return res.status(422).json({ error: 'Too many redirects' });
        }
        try { response.body?.destroy?.(); } catch { /* noop */ }
        // Every redirect hop is re-validated against private address space AND
        // re-pinned to the freshly validated answers (hop-by-hop TOCTOU guard).
        ({ url: currentUrl, addresses } = await resolvePublicUrl(
          new URL(location, currentUrl).toString(),
        ));
        continue;
      }
      break;
    }

    if (!response || !response.ok) {
      return res.status(422).json({
        error: `Fetch failed with status ${response ? response.status : 'unknown'}`,
      });
    }

    const contentType = response.headers.get('content-type') || '';
    const buffer = await readCappedBody(response, controller.signal);

    if (contentType.includes('text/html') || contentType.includes('xhtml')) {
      const { title, text } = htmlToText(decodeBodyText(buffer, contentType));
      const capped = capText(text);
      if (!capped.text) return res.status(422).json({ error: 'No readable text found on the page' });
      return res.json({
        url: currentUrl.toString(),
        title: title || currentUrl.hostname,
        chars: capped.text.length,
        truncated: capped.truncated || buffer.length >= MAX_URL_BYTES,
        text: capped.text,
      });
    }

    if (contentType.includes('text/') || contentType.includes('json') || contentType.includes('xml')) {
      const capped = capText(decodeBodyText(buffer, contentType));
      return res.json({
        url: currentUrl.toString(),
        title: currentUrl.hostname,
        chars: capped.text.length,
        truncated: capped.truncated || buffer.length >= MAX_URL_BYTES,
        text: capped.text,
      });
    }

    return res.status(422).json({ error: `Unsupported content type: ${contentType || 'unknown'}` });
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      return res.status(408).json({
        error: `Fetch timed out after ${FETCH_TIMEOUT_MS}ms (connect + headers + body)`,
      });
    }
    if (error?.name === 'FetchError') {
      return res.status(422).json({ error: `Could not fetch URL: ${error.message}` });
    }
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    clearTimeout(deadline);
    dropAgent();
  }
});

export default router;
