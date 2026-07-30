// Project file CRUD + file-tree endpoints (moved out of server/index.js).
// The composition root injects auth middleware and mounts the router at the
// app root, preserving the original route order and auth semantics.
export { createFilesRouter } from './files.routes.js';
export { getFileTree, getFileTreeMaxEntries } from './services/file-tree.service.js';
export { validatePathInProject, validateFilename } from './services/path-validation.service.js';
