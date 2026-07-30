import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import {
  buildClaudeUserContent,
  getGlobalImageAssetsDir,
  isAllowedImageSourcePath,
  normalizeImageDescriptors,
  resolveImageMediaType,
} from '@/shared/image-attachments.js';

// 1x1 transparent PNG
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const SYMLINK_UNSUPPORTED_CODES = new Set(['EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EPERM']);

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function createSymlinkIfSupported(
  target: string,
  linkPath: string,
  type: 'dir' | 'file' | 'junction',
): Promise<boolean> {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (error) {
    if (
      isErrnoException(error) &&
      typeof error.code === 'string' &&
      SYMLINK_UNSUPPORTED_CODES.has(error.code)
    ) {
      return false;
    }
    throw error;
  }
}

test('normalizeImageDescriptors accepts objects and bare paths, drops junk', () => {
  const descriptors = normalizeImageDescriptors([
    { path: '.cloudcli/assets/a.png', name: 'a.png', mimeType: 'image/png' },
    'scripts/pic.jpg',
    { name: 'no-path.png' },
    42,
    null,
    '',
  ]);

  assert.deepEqual(descriptors, [
    { path: '.cloudcli/assets/a.png', name: 'a.png', mimeType: 'image/png' },
    { path: 'scripts/pic.jpg' },
  ]);
  assert.deepEqual(normalizeImageDescriptors(undefined), []);
  assert.deepEqual(normalizeImageDescriptors('not-an-array'), []);
});

test('resolveImageMediaType prefers the mime type and falls back to the extension', () => {
  assert.equal(resolveImageMediaType({ path: 'x.bin', mimeType: 'image/webp' }), 'image/webp');
  assert.equal(resolveImageMediaType({ path: 'x.JPG' }), 'image/jpeg');
  assert.equal(resolveImageMediaType({ path: 'x.png' }), 'image/png');
  assert.equal(resolveImageMediaType({ path: 'x.unknown' }), null);
});

test('buildClaudeUserContent reads image bytes into base64 blocks', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'image-attachments-'));
  try {
    await writeFile(path.join(tempDir, 'shot.png'), PNG_BYTES);

    const content = await buildClaudeUserContent(
      'What is in this image?',
      [{ path: 'shot.png', mimeType: 'image/png' }],
      tempDir,
    );

    assert.equal(content.length, 2);
    assert.deepEqual(content[0], { type: 'text', text: 'What is in this image?' });
    assert.equal(content[1].type, 'image');
    const imageBlock = content[1] as Extract<(typeof content)[number], { type: 'image' }>;
    assert.equal(imageBlock.source.type, 'base64');
    assert.equal(imageBlock.source.media_type, 'image/png');
    assert.equal(imageBlock.source.data, PNG_BYTES.toString('base64'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('buildClaudeUserContent skips unsupported types and unreadable files', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'image-attachments-'));
  try {
    await writeFile(path.join(tempDir, 'vector.svg'), '<svg></svg>');

    const content = await buildClaudeUserContent(
      'prompt',
      [
        { path: 'vector.svg', mimeType: 'image/svg+xml' },
        { path: 'missing.png', mimeType: 'image/png' },
      ],
      tempDir,
    );

    // Only the text block survives; the prompt still goes through.
    assert.deepEqual(content, [{ type: 'text', text: 'prompt' }]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('buildClaudeUserContent refuses symlinked images outside allowed roots', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'image-attachments-'));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'image-attachments-outside-'));
  try {
    const outsideFile = path.join(outsideDir, 'secret.png');
    await writeFile(outsideFile, PNG_BYTES);

    const linkPath = path.join(tempDir, 'linked-secret.png');
    if (!(await createSymlinkIfSupported(outsideFile, linkPath, 'file'))) {
      t.skip('Symlink creation is not supported in this environment');
      return;
    }

    const content = await buildClaudeUserContent(
      'prompt',
      [{ path: 'linked-secret.png', mimeType: 'image/png' }],
      tempDir,
    );

    assert.deepEqual(content, [{ type: 'text', text: 'prompt' }]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('buildClaudeUserContent accepts images under a symlinked cwd', async (t) => {
  const realProjectDir = await mkdtemp(path.join(os.tmpdir(), 'image-attachments-project-'));
  const linkParentDir = await mkdtemp(path.join(os.tmpdir(), 'image-attachments-link-'));
  try {
    await writeFile(path.join(realProjectDir, 'shot.png'), PNG_BYTES);

    const linkCwd = path.join(linkParentDir, 'project-link');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    if (!(await createSymlinkIfSupported(realProjectDir, linkCwd, linkType))) {
      t.skip('Symlink creation is not supported in this environment');
      return;
    }

    const content = await buildClaudeUserContent(
      'prompt',
      [{ path: 'shot.png', mimeType: 'image/png' }],
      linkCwd,
    );

    assert.equal(content.length, 2);
    assert.equal(content[1].type, 'image');
    const imageBlock = content[1] as Extract<(typeof content)[number], { type: 'image' }>;
    assert.equal(imageBlock.source.data, PNG_BYTES.toString('base64'));
  } finally {
    await rm(linkParentDir, { recursive: true, force: true });
    await rm(realProjectDir, { recursive: true, force: true });
  }
});

test('isAllowedImageSourcePath only accepts the upload store and the run cwd', () => {
  const cwd = path.join(os.tmpdir(), 'some-project');
  // Ask the module where the store is rather than rebuilding the path here.
  // A literal `~/.cloudcli/assets` used to be hardcoded in this test, which
  // meant it kept passing after the store moved and stopped testing anything.
  const uploadStore = getGlobalImageAssetsDir();

  assert.equal(isAllowedImageSourcePath(path.join(uploadStore, 'shot.png'), cwd), true);
  assert.equal(isAllowedImageSourcePath(path.join(cwd, 'docs', 'diagram.png'), cwd), true);

  assert.equal(isAllowedImageSourcePath(path.join(os.homedir(), '.ssh', 'id_rsa'), cwd), false);
  assert.equal(isAllowedImageSourcePath(path.join(cwd, '..', 'other-project', 'x.png'), cwd), false);
  // The roots themselves are directories, not readable image files.
  assert.equal(isAllowedImageSourcePath(cwd, cwd), false);
});

test('buildClaudeUserContent refuses descriptors outside the allowed roots', async () => {
  const cwd = path.join(os.tmpdir(), 'some-project');
  const outsidePath = path.join(os.homedir(), '.ssh', 'id_rsa.png');

  const claudeContent = await buildClaudeUserContent(
    'prompt',
    [{ path: outsidePath, mimeType: 'image/png' }],
    cwd,
  );
  assert.deepEqual(claudeContent, [{ type: 'text', text: 'prompt' }]);
});
