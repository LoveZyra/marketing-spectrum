/**
 * 静态挂载顺序:**dist 必须排在 public 前面。**
 *
 * 2026-09-15 在测试环境上踩到的:`public/` 里躺着一份 2026-09-02 的旧构建
 * (`index.html` + `assets/`),而它当时挂在 dist 前面 —— 于是
 *
 *   - 打开 `http://host:8080/` 或 `/index.html` → public 先答 → **两周前的前端**
 *     (`cache-control: public, max-age=0`、`last-modified: 2026-09-02`);
 *   - 打开 `/session/xxx` 这种无扩展名深链 → `app.get('*')` 送 dist/index.html
 *     → **当天的前端**(`no-cache`、`last-modified` 是构建时间)。
 *
 * 同一台机器"有时新版有时老版",就是这么来的。发布包里不含 `public/index.html`
 * 与 `public/assets/`,所以 `tar --overwrite` 永远删不掉那份残留 ——
 * 顺序一旦被改回去,症状会原样复发,而且在网络面板里只看得到 200/304。
 *
 * 这里对源码断言(挂载顺序是一行 `app.use` 的位置,跑起来才发现就太晚了)。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8');

describe('静态资源的挂载顺序', () => {
  test('dist 的 express.static 排在 public 的前面', () => {
    const distAt = source.indexOf("express.static(path.join(APP_ROOT, 'dist')");
    const publicAt = source.indexOf("express.static(path.join(APP_ROOT, 'public')");
    assert.ok(distAt > -1, '找不到 dist 的静态挂载');
    assert.ok(publicAt > -1, '找不到 public 的静态挂载');
    assert.ok(
      distAt < publicAt,
      'public 排到了 dist 前面 —— public/ 里任何与构建产物同名的文件都会把应用盖掉',
    );
  });

  test('public 那层关掉目录索引,连 `/` 都不接', () => {
    const publicAt = source.indexOf("express.static(path.join(APP_ROOT, 'public')");
    const line = source.slice(publicAt, source.indexOf('\n', publicAt));
    assert.match(line, /index:\s*false/, 'public 静态层要带 { index: false }');
  });

  test('dist 那层仍然自己设缓存头(HTML 不缓存 / 带 hash 的资源 immutable)', () => {
    const distAt = source.indexOf("express.static(path.join(APP_ROOT, 'dist')");
    const block = source.slice(distAt, distAt + 800);
    assert.match(block, /no-cache, no-store, must-revalidate/);
    assert.match(block, /max-age=31536000, immutable/);
  });

  test('开机会对 public/ 里的构建产物残留喊一声', () => {
    assert.match(source, /warnAboutStalePublicBuild\(\)/, '启动流程里没有调用这个检查');
    assert.match(source, /function warnAboutStalePublicBuild/, '找不到这个检查的实现');
  });
});
