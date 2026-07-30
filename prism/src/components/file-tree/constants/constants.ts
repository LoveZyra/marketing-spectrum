import type { FileTreeViewMode } from '../types/types';

export const FILE_TREE_VIEW_MODE_STORAGE_KEY = 'file-tree-view-mode';

export const FILE_TREE_DEFAULT_VIEW_MODE: FileTreeViewMode = 'detailed';

export const FILE_TREE_VIEW_MODES: FileTreeViewMode[] = ['simple', 'compact', 'detailed'];

// Whole gigabytes read as a typo when spelled in megabytes ("1024MB").
const formatUploadSizeLabel = (megabytes: number): string => (
  megabytes % 1024 === 0 ? `${megabytes / 1024}GB` : `${megabytes}MB`
);

// Must stay in step with MAX_FILE_UPLOAD_SIZE_MB in
// server/modules/files/files.routes.ts, which is the cap multer actually
// enforces; this copy only exists to reject oversized files before the upload
// starts and to label the upload button.
export const MAX_FILE_UPLOAD_SIZE_MB = 1024;

export const MAX_FILE_UPLOAD_SIZE_BYTES = MAX_FILE_UPLOAD_SIZE_MB * 1024 * 1024;

export const MAX_FILE_UPLOAD_SIZE_LABEL = formatUploadSizeLabel(MAX_FILE_UPLOAD_SIZE_MB);

export const MAX_FILE_UPLOAD_COUNT = 20;

// Mirrors DEFAULT_MAX_FILE_UPLOAD_TOTAL_MB in files.routes.ts. The server value
// is env-overridable (PRISM_UPLOAD_MAX_TOTAL_MB) and this one is not, so this is
// only ever a fast-fail default: the server stays the authority. An operator who
// raises the server cap gets a client that is stricter than it needs to be,
// which is the safe direction to be wrong in — the alternative is a browser that
// spends twenty minutes uploading before the server says no.
export const MAX_FILE_UPLOAD_TOTAL_MB = 2048;

export const MAX_FILE_UPLOAD_TOTAL_BYTES = MAX_FILE_UPLOAD_TOTAL_MB * 1024 * 1024;

export const MAX_FILE_UPLOAD_TOTAL_LABEL = formatUploadSizeLabel(MAX_FILE_UPLOAD_TOTAL_MB);

export const IMAGE_FILE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'ico',
  'bmp',
]);
