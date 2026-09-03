import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { filterImagesToUploadStore } from '@/modules/websocket/services/chat-websocket.service.js';

const STORE = path.join(os.tmpdir(), 'cloudcli-assets-store');

test('images inside the upload store pass through', () => {
  const inside = path.join(STORE, 'shot.png');
  const result = filterImagesToUploadStore(
    [{ path: inside, name: 'shot.png', mimeType: 'image/png' }],
    STORE,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, inside);
});

test('bare filenames are anchored inside the store', () => {
  const result = filterImagesToUploadStore(['shot.png'], STORE);
  assert.equal(result.length, 1);
});

test('paths outside the store, traversal, and subdirs are dropped', () => {
  const result = filterImagesToUploadStore(
    [
      { path: 'C:/Users/victim/.ssh/id_rsa' },
      { path: '/etc/passwd' },
      { path: '../outside.png' },
      { path: path.join(STORE, '..', 'escaped.png') },
      { path: path.join(STORE, 'nested', 'deep.png') },
      { path: STORE }, // the store folder itself is not a file
    ],
    STORE,
  );
  assert.deepEqual(result, []);
});

test('malformed payloads yield no images', () => {
  assert.deepEqual(filterImagesToUploadStore(undefined, STORE), []);
  assert.deepEqual(filterImagesToUploadStore('nope', STORE), []);
  assert.deepEqual(filterImagesToUploadStore([{ name: 'no-path' }, 42], STORE), []);
});

/**
 * ed:会话项目的 attachments/ 也是合法来源。
 * cu 起图片按项目落盘,这道门却只认全局目录 —— 项目会话里的每张图都被丢:模型看不到、
 * 落库的用户行没有 images、回合一结束气泡里的图就消失(用户实测)。
 */
test('session project attachments/ is an additional allowed root (direct children only)', () => {
  const projectAttachments = path.join(os.tmpdir(), 'probe-proj', 'attachments');
  const result = filterImagesToUploadStore(
    [
      { path: path.join(projectAttachments, 'shot.png'), name: 'shot.png', mimeType: 'image/png' },
      { path: path.join(STORE, 'global.png') },
      { path: path.join(projectAttachments, 'nested', 'deep.png') },
      { path: path.join(projectAttachments, '..', 'src', 'secret.png') },
      { path: path.join(os.tmpdir(), 'other-proj', 'attachments', 'x.png') },
    ],
    STORE,
    [projectAttachments],
  );
  assert.deepEqual(result.map((entry) => entry.path), [
    path.join(projectAttachments, 'shot.png'),
    path.join(STORE, 'global.png'),
  ]);
});

test('no extra roots → behaviour unchanged (only the global store)', () => {
  const projectAttachments = path.join(os.tmpdir(), 'probe-proj', 'attachments');
  const result = filterImagesToUploadStore([{ path: path.join(projectAttachments, 'shot.png') }], STORE);
  assert.deepEqual(result, []);
});
