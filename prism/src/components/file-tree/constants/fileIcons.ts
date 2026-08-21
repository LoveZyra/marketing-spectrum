import {
  Archive,
  Binary,
  Blocks,
  BookOpen,
  Box,
  Braces,
  Code2,
  Cog,
  Coffee,
  Cpu,
  Database,
  File,
  FileCheck,
  FileCode,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FileType,
  Flame,
  FlaskConical,
  Gem,
  Globe,
  Hash,
  Hexagon,
  Image,
  Lock,
  Music2,
  NotebookPen,
  Palette,
  Scroll,
  Settings,
  Shield,
  SquareFunction,
  Terminal,
  Video,
  Workflow,
} from 'lucide-react';

import type { FileIconData, FileIconMap } from '../types/types';

export const ICON_SIZE_CLASS = 'w-4 h-4 flex-shrink-0';

const FILE_ICON_MAP: FileIconMap = {
  js: { icon: FileCode, color: 'text-muted-foreground' },
  jsx: { icon: FileCode, color: 'text-muted-foreground' },
  mjs: { icon: FileCode, color: 'text-muted-foreground' },
  cjs: { icon: FileCode, color: 'text-muted-foreground' },
  ts: { icon: FileCode2, color: 'text-muted-foreground' },
  tsx: { icon: FileCode2, color: 'text-muted-foreground' },
  mts: { icon: FileCode2, color: 'text-muted-foreground' },
  py: { icon: Code2, color: 'text-muted-foreground' },
  pyw: { icon: Code2, color: 'text-muted-foreground' },
  pyi: { icon: Code2, color: 'text-muted-foreground' },
  ipynb: { icon: NotebookPen, color: 'text-muted-foreground' },
  rs: { icon: Cog, color: 'text-muted-foreground' },
  toml: { icon: Settings, color: 'text-muted-foreground' },
  go: { icon: Hexagon, color: 'text-muted-foreground' },
  rb: { icon: Gem, color: 'text-muted-foreground' },
  erb: { icon: Gem, color: 'text-muted-foreground' },
  php: { icon: Blocks, color: 'text-muted-foreground' },
  java: { icon: Coffee, color: 'text-muted-foreground' },
  jar: { icon: Coffee, color: 'text-muted-foreground' },
  kt: { icon: Hexagon, color: 'text-muted-foreground' },
  kts: { icon: Hexagon, color: 'text-muted-foreground' },
  c: { icon: Cpu, color: 'text-muted-foreground' },
  h: { icon: Cpu, color: 'text-muted-foreground' },
  cpp: { icon: Cpu, color: 'text-muted-foreground' },
  hpp: { icon: Cpu, color: 'text-muted-foreground' },
  cc: { icon: Cpu, color: 'text-muted-foreground' },
  cs: { icon: Hexagon, color: 'text-muted-foreground' },
  swift: { icon: Flame, color: 'text-muted-foreground' },
  lua: { icon: SquareFunction, color: 'text-muted-foreground' },
  r: { icon: FlaskConical, color: 'text-muted-foreground' },
  html: { icon: Globe, color: 'text-muted-foreground' },
  htm: { icon: Globe, color: 'text-muted-foreground' },
  css: { icon: Hash, color: 'text-muted-foreground' },
  scss: { icon: Hash, color: 'text-muted-foreground' },
  sass: { icon: Hash, color: 'text-muted-foreground' },
  less: { icon: Hash, color: 'text-muted-foreground' },
  vue: { icon: FileCode2, color: 'text-muted-foreground' },
  svelte: { icon: FileCode2, color: 'text-muted-foreground' },
  json: { icon: Braces, color: 'text-muted-foreground' },
  jsonc: { icon: Braces, color: 'text-muted-foreground' },
  json5: { icon: Braces, color: 'text-muted-foreground' },
  yaml: { icon: Settings, color: 'text-muted-foreground' },
  yml: { icon: Settings, color: 'text-muted-foreground' },
  xml: { icon: FileCode, color: 'text-muted-foreground' },
  csv: { icon: FileSpreadsheet, color: 'text-muted-foreground' },
  tsv: { icon: FileSpreadsheet, color: 'text-muted-foreground' },
  sql: { icon: Database, color: 'text-muted-foreground' },
  graphql: { icon: Workflow, color: 'text-muted-foreground' },
  gql: { icon: Workflow, color: 'text-muted-foreground' },
  proto: { icon: Box, color: 'text-muted-foreground' },
  env: { icon: Shield, color: 'text-muted-foreground' },
  md: { icon: BookOpen, color: 'text-muted-foreground' },
  mdx: { icon: BookOpen, color: 'text-muted-foreground' },
  txt: { icon: FileText, color: 'text-muted-foreground' },
  doc: { icon: FileText, color: 'text-muted-foreground' },
  docx: { icon: FileText, color: 'text-muted-foreground' },
  pdf: { icon: FileCheck, color: 'text-muted-foreground' },
  rtf: { icon: FileText, color: 'text-muted-foreground' },
  tex: { icon: Scroll, color: 'text-muted-foreground' },
  rst: { icon: FileText, color: 'text-muted-foreground' },
  sh: { icon: Terminal, color: 'text-muted-foreground' },
  bash: { icon: Terminal, color: 'text-muted-foreground' },
  zsh: { icon: Terminal, color: 'text-muted-foreground' },
  fish: { icon: Terminal, color: 'text-muted-foreground' },
  ps1: { icon: Terminal, color: 'text-muted-foreground' },
  bat: { icon: Terminal, color: 'text-muted-foreground' },
  cmd: { icon: Terminal, color: 'text-muted-foreground' },
  png: { icon: Image, color: 'text-muted-foreground' },
  jpg: { icon: Image, color: 'text-muted-foreground' },
  jpeg: { icon: Image, color: 'text-muted-foreground' },
  gif: { icon: Image, color: 'text-muted-foreground' },
  webp: { icon: Image, color: 'text-muted-foreground' },
  ico: { icon: Image, color: 'text-muted-foreground' },
  bmp: { icon: Image, color: 'text-muted-foreground' },
  tiff: { icon: Image, color: 'text-muted-foreground' },
  svg: { icon: Palette, color: 'text-muted-foreground' },
  mp3: { icon: Music2, color: 'text-muted-foreground' },
  wav: { icon: Music2, color: 'text-muted-foreground' },
  ogg: { icon: Music2, color: 'text-muted-foreground' },
  flac: { icon: Music2, color: 'text-muted-foreground' },
  aac: { icon: Music2, color: 'text-muted-foreground' },
  m4a: { icon: Music2, color: 'text-muted-foreground' },
  mp4: { icon: Video, color: 'text-muted-foreground' },
  mov: { icon: Video, color: 'text-muted-foreground' },
  avi: { icon: Video, color: 'text-muted-foreground' },
  webm: { icon: Video, color: 'text-muted-foreground' },
  mkv: { icon: Video, color: 'text-muted-foreground' },
  ttf: { icon: FileType, color: 'text-muted-foreground' },
  otf: { icon: FileType, color: 'text-muted-foreground' },
  woff: { icon: FileType, color: 'text-muted-foreground' },
  woff2: { icon: FileType, color: 'text-muted-foreground' },
  eot: { icon: FileType, color: 'text-muted-foreground' },
  zip: { icon: Archive, color: 'text-muted-foreground' },
  tar: { icon: Archive, color: 'text-muted-foreground' },
  gz: { icon: Archive, color: 'text-muted-foreground' },
  bz2: { icon: Archive, color: 'text-muted-foreground' },
  rar: { icon: Archive, color: 'text-muted-foreground' },
  '7z': { icon: Archive, color: 'text-muted-foreground' },
  lock: { icon: Lock, color: 'text-muted-foreground' },
  exe: { icon: Binary, color: 'text-muted-foreground' },
  bin: { icon: Binary, color: 'text-muted-foreground' },
  dll: { icon: Binary, color: 'text-muted-foreground' },
  so: { icon: Binary, color: 'text-muted-foreground' },
  dylib: { icon: Binary, color: 'text-muted-foreground' },
  wasm: { icon: Binary, color: 'text-muted-foreground' },
  ini: { icon: Settings, color: 'text-muted-foreground' },
  cfg: { icon: Settings, color: 'text-muted-foreground' },
  conf: { icon: Settings, color: 'text-muted-foreground' },
  log: { icon: Scroll, color: 'text-muted-foreground' },
  map: { icon: File, color: 'text-muted-foreground' },
};

const FILENAME_ICON_MAP: FileIconMap = {
  Dockerfile: { icon: Box, color: 'text-muted-foreground' },
  'docker-compose.yml': { icon: Box, color: 'text-muted-foreground' },
  'docker-compose.yaml': { icon: Box, color: 'text-muted-foreground' },
  '.dockerignore': { icon: Box, color: 'text-muted-foreground' },
  '.gitignore': { icon: Settings, color: 'text-muted-foreground' },
  '.gitmodules': { icon: Settings, color: 'text-muted-foreground' },
  '.gitattributes': { icon: Settings, color: 'text-muted-foreground' },
  '.editorconfig': { icon: Settings, color: 'text-muted-foreground' },
  '.prettierrc': { icon: Settings, color: 'text-muted-foreground' },
  '.prettierignore': { icon: Settings, color: 'text-muted-foreground' },
  '.eslintrc': { icon: Settings, color: 'text-muted-foreground' },
  '.eslintrc.js': { icon: Settings, color: 'text-muted-foreground' },
  '.eslintrc.json': { icon: Settings, color: 'text-muted-foreground' },
  '.eslintrc.cjs': { icon: Settings, color: 'text-muted-foreground' },
  'eslint.config.js': { icon: Settings, color: 'text-muted-foreground' },
  'eslint.config.mjs': { icon: Settings, color: 'text-muted-foreground' },
  '.env': { icon: Shield, color: 'text-muted-foreground' },
  '.env.local': { icon: Shield, color: 'text-muted-foreground' },
  '.env.development': { icon: Shield, color: 'text-muted-foreground' },
  '.env.production': { icon: Shield, color: 'text-muted-foreground' },
  '.env.example': { icon: Shield, color: 'text-muted-foreground' },
  'package.json': { icon: Braces, color: 'text-muted-foreground' },
  'package-lock.json': { icon: Lock, color: 'text-muted-foreground' },
  'yarn.lock': { icon: Lock, color: 'text-muted-foreground' },
  'pnpm-lock.yaml': { icon: Lock, color: 'text-muted-foreground' },
  'bun.lockb': { icon: Lock, color: 'text-muted-foreground' },
  'Cargo.toml': { icon: Cog, color: 'text-muted-foreground' },
  'Cargo.lock': { icon: Lock, color: 'text-muted-foreground' },
  Gemfile: { icon: Gem, color: 'text-muted-foreground' },
  'Gemfile.lock': { icon: Lock, color: 'text-muted-foreground' },
  Makefile: { icon: Terminal, color: 'text-muted-foreground' },
  'CMakeLists.txt': { icon: Cog, color: 'text-muted-foreground' },
  'tsconfig.json': { icon: Braces, color: 'text-muted-foreground' },
  'jsconfig.json': { icon: Braces, color: 'text-muted-foreground' },
  'vite.config.ts': { icon: Flame, color: 'text-muted-foreground' },
  'vite.config.js': { icon: Flame, color: 'text-muted-foreground' },
  'webpack.config.js': { icon: Cog, color: 'text-muted-foreground' },
  'tailwind.config.js': { icon: Hash, color: 'text-muted-foreground' },
  'tailwind.config.ts': { icon: Hash, color: 'text-muted-foreground' },
  'postcss.config.js': { icon: Cog, color: 'text-muted-foreground' },
  'babel.config.js': { icon: Settings, color: 'text-muted-foreground' },
  '.babelrc': { icon: Settings, color: 'text-muted-foreground' },
  'README.md': { icon: BookOpen, color: 'text-muted-foreground' },
  LICENSE: { icon: FileCheck, color: 'text-muted-foreground' },
  'LICENSE.md': { icon: FileCheck, color: 'text-muted-foreground' },
  'CHANGELOG.md': { icon: Scroll, color: 'text-muted-foreground' },
  'requirements.txt': { icon: FileText, color: 'text-muted-foreground' },
  'go.mod': { icon: Hexagon, color: 'text-muted-foreground' },
  'go.sum': { icon: Lock, color: 'text-muted-foreground' },
};

// Icon resolution is deterministic: exact filename, then .env prefixes, then extension, then fallback.
export function getFileIconData(filename: string): FileIconData {
  if (FILENAME_ICON_MAP[filename]) {
    return FILENAME_ICON_MAP[filename];
  }

  if (filename.startsWith('.env')) {
    return { icon: Shield, color: 'text-muted-foreground' };
  }

  const extension = filename.split('.').pop()?.toLowerCase();
  if (extension && FILE_ICON_MAP[extension]) {
    return FILE_ICON_MAP[extension];
  }

  return { icon: File, color: 'text-muted-foreground' };
}

/**
 * 文件类型的**七个语义族**。
 *
 * `FILE_ICON_MAP` 已经给每种类型分了图标,但颜色一律 `text-muted-foreground` ——
 * 一列灰图标,扫一眼分不出哪些是代码、哪些是配置、哪些是密钥。两份浅色设计稿
 * (`light-ui/`)都要求按族分色,并且明确"**不动图标映射**",所以这里只加一层
 * 族归属,原来的图标解析一行不改。
 *
 * 色值由主题给(`--filetype-*`):两套浅色用设计稿的七色,霓虹终端下全部落回
 * 次级墨色 —— 深色那一稿没有这个特性,不该被这轮顺手改掉。
 */
export type FileFamily = 'dir' | 'code' | 'data' | 'config' | 'doc' | 'runtime' | 'secret' | 'plain';

const FAMILY_BY_EXTENSION: Record<string, FileFamily> = {};

const registerFamily = (family: FileFamily, extensions: string[]) => {
  for (const extension of extensions) FAMILY_BY_EXTENSION[extension] = family;
};

registerFamily('code', [
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'py', 'pyw', 'pyi', 'ipynb', 'vue', 'svelte',
  'html', 'htm', 'rs', 'go', 'rb', 'erb', 'java', 'kt', 'kts', 'swift', 'c', 'cc', 'cpp', 'h',
  'hpp', 'cs', 'php', 'scala', 'dart', 'lua', 'r', 'ex', 'exs', 'elm', 'clj', 'hs', 'ml', 'pl',
  'css', 'scss', 'sass', 'less',
]);
registerFamily('data', ['json', 'json5', 'jsonc', 'csv', 'tsv', 'sql', 'db', 'sqlite', 'parquet', 'avro']);
registerFamily('config', [
  'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'properties', 'editorconfig', 'babelrc',
  'eslintrc', 'prettierrc', 'npmrc', 'nvmrc', 'gitignore', 'gitattributes', 'dockerignore',
]);
registerFamily('doc', ['md', 'mdx', 'markdown', 'txt', 'pdf', 'rst', 'adoc', 'doc', 'docx', 'rtf']);
registerFamily('runtime', ['sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'mk']);
registerFamily('secret', ['lock', 'pem', 'key', 'crt', 'cer', 'p12', 'keystore']);

const FAMILY_BY_FILENAME: Record<string, FileFamily> = {
  Dockerfile: 'runtime',
  'docker-compose.yml': 'runtime',
  'docker-compose.yaml': 'runtime',
  Makefile: 'runtime',
  Procfile: 'runtime',
  LICENSE: 'doc',
  'LICENSE.md': 'doc',
  NOTICE: 'doc',
  'NOTICE.md': 'doc',
  'README.md': 'doc',
  'CHANGELOG.md': 'doc',
  'requirements.txt': 'data',
  'go.sum': 'secret',
};

/** 目录单独一族。调用方对目录不走 `getFileIconData`,所以这里显式给一个入口。 */
export function getFileFamily(filename: string, isDirectory = false): FileFamily {
  if (isDirectory) return 'dir';
  if (FAMILY_BY_FILENAME[filename]) return FAMILY_BY_FILENAME[filename];
  if (filename.startsWith('.env')) return 'secret';

  const extension = filename.split('.').pop()?.toLowerCase();
  if (extension && FAMILY_BY_EXTENSION[extension]) return FAMILY_BY_EXTENSION[extension];
  return 'plain';
}

/** 族 → 颜色类。`plain` 保持原样,不额外上色。 */
export const FAMILY_COLOR_CLASS: Record<FileFamily, string> = {
  dir: 'filetype-dir',
  code: 'filetype-code',
  data: 'filetype-data',
  config: 'filetype-config',
  doc: 'filetype-doc',
  runtime: 'filetype-runtime',
  secret: 'filetype-secret',
  plain: 'text-muted-foreground',
};
