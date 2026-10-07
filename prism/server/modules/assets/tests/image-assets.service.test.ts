import assert from 'node:assert/strict';
import path from 'node:path';

import { test } from 'vitest';

import {
  buildStoredImageRecords,
  isAllowedImageMimeType,
  resolveImageAssetFile,
} from '@/modules/assets/services/image-assets.service.js';
import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';

// Derived from the module's own accessor rather than a hardcoded literal, so the
// assertions follow the service wherever it actually writes.
const ASSETS_DIR = getGlobalImageAssetsDir();

test('isAllowedImageMimeType accepts image formats and rejects the rest', () => {
  assert.equal(isAllowedImageMimeType('image/png'), true);
  // SVG 不在白名单:发送给模型时会被静默丢掉,用户只会看到模型说没看到图片。上传即拒更诚实。
  assert.equal(isAllowedImageMimeType('image/svg+xml'), false);
  assert.equal(isAllowedImageMimeType('application/pdf'), false);
  assert.equal(isAllowedImageMimeType('text/html'), false);
});

test('buildStoredImageRecords returns absolute posix paths in the assets dir', () => {
  const records = buildStoredImageRecords([
    { originalname: 'shot.png', filename: '123-456-shot.png', size: 42, mimetype: 'image/png' },
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'shot.png');
  assert.equal(records[0].size, 42);
  assert.equal(records[0].mimeType, 'image/png');
  assert.equal(records[0].path, `${ASSETS_DIR.replace(/\\/g, '/')}/123-456-shot.png`);
});

test('resolveImageAssetFile resolves plain filenames inside the assets dir', () => {
  const resolved = resolveImageAssetFile('123-shot.png');
  assert.equal(resolved, path.join(path.resolve(ASSETS_DIR), '123-shot.png'));
});

test('resolveImageAssetFile rejects traversal and separator attempts', () => {
  assert.equal(resolveImageAssetFile(''), null);
  assert.equal(resolveImageAssetFile('   '), null);
  assert.equal(resolveImageAssetFile('../auth.db'), null);
  assert.equal(resolveImageAssetFile('..'), null);
  assert.equal(resolveImageAssetFile('sub/dir.png'), null);
  assert.equal(resolveImageAssetFile('sub\\dir.png'), null);
  assert.equal(resolveImageAssetFile('a..b/../c.png'), null);
});
