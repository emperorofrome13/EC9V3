import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const CHUNK_ROOT = '.ec9v3-context-chunks';
const DEFAULT_MAX_INLINE_BYTES = 96 * 1024;
const DEFAULT_CHUNK_BYTES = 48 * 1024;

export interface FileChunkOptions {
  enabled?: boolean;
  maxInlineBytes?: number;
  chunkBytes?: number;
}

function normalizeRelativePath(workingDir: string, filePath: string): string {
  return path.relative(path.resolve(workingDir), path.resolve(filePath)).replace(/\\/g, '/');
}

function sanitizeForDirectory(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'file';
}

export async function chunkFileForContext(
  workingDir: string,
  fullPath: string,
  requestedPath: string,
  options?: FileChunkOptions,
): Promise<string | null> {
  if (!options?.enabled) return null;

  const relativePath = normalizeRelativePath(workingDir, fullPath);
  if (relativePath.startsWith(`${CHUNK_ROOT}/`) || relativePath === CHUNK_ROOT) return null;

  const stat = await fs.stat(fullPath);
  if (!stat.isFile()) return null;

  const maxInlineBytes = Math.max(8 * 1024, options.maxInlineBytes || DEFAULT_MAX_INLINE_BYTES);
  if (stat.size <= maxInlineBytes) return null;

  const chunkBytes = Math.max(4 * 1024, options.chunkBytes || DEFAULT_CHUNK_BYTES);
  const content = await fs.readFile(fullPath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const hash = crypto.createHash('sha1').update(`${relativePath}:${stat.mtimeMs}:${stat.size}`).digest('hex').slice(0, 10);
  const chunkDirName = `${sanitizeForDirectory(relativePath)}-${hash}`;
  const chunkDir = path.join(workingDir, CHUNK_ROOT, chunkDirName);

  await fs.rm(chunkDir, { recursive: true, force: true });
  await fs.mkdir(chunkDir, { recursive: true });

  const chunks: Array<{ path: string; startLine: number; endLine: number; bytes: number }> = [];
  let currentLines: string[] = [];
  let currentBytes = 0;
  let startLine = 1;

  async function flushChunk(endLine: number) {
    if (currentLines.length === 0) return;
    const index = chunks.length + 1;
    const chunkName = `chunk-${String(index).padStart(3, '0')}.txt`;
    const fullChunkPath = path.join(chunkDir, chunkName);
    const chunkContent = currentLines.join('\n');
    await fs.writeFile(fullChunkPath, chunkContent, 'utf-8');
    chunks.push({
      path: path.relative(workingDir, fullChunkPath).replace(/\\/g, '/'),
      startLine,
      endLine,
      bytes: Buffer.byteLength(chunkContent, 'utf-8'),
    });
    currentLines = [];
    currentBytes = 0;
    startLine = endLine + 1;
  }

  for (let index = 0; index < lines.length; index++) {
    const logicalLine = index + 1;
    const line = lines[index];
    const lineBytes = Buffer.byteLength(line, 'utf-8') + 1;
    if (currentLines.length > 0 && currentBytes + lineBytes > chunkBytes) {
      await flushChunk(logicalLine - 1);
    }
    currentLines.push(line);
    currentBytes += lineBytes;
  }

  await flushChunk(lines.length);

  const manifestPath = path.join(chunkDir, 'manifest.txt');
  const manifest = [
    `Context overload protection split this large file instead of returning it inline.`,
    `Original file: ${requestedPath}`,
    `Original relative path: ${relativePath}`,
    `Original size: ${stat.size} bytes`,
    `Total lines: ${lines.length}`,
    `Chunk count: ${chunks.length}`,
    `Chunk directory: ${path.relative(workingDir, chunkDir).replace(/\\/g, '/')}`,
    ``,
    `Read the needed chunk files with read_file. The original file was not modified.`,
    `Do not edit files under ${CHUNK_ROOT}; edit the original file path when making changes.`,
    ``,
    ...chunks.map((chunk, index) =>
      `${String(index + 1).padStart(3, '0')}. ${chunk.path} | lines ${chunk.startLine}-${chunk.endLine} | ${chunk.bytes} bytes`
    ),
    ``,
    `Manifest: ${path.relative(workingDir, manifestPath).replace(/\\/g, '/')}`,
  ].join('\n');

  await fs.writeFile(manifestPath, manifest, 'utf-8');
  return manifest;
}
