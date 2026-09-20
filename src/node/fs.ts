import { promises as fsp } from 'node:fs';
import * as nodePath from 'node:path';
import type { TextFs } from '../archive/file-store.js';

/**
 * A tiny text-file abstraction so the same archive code runs on Node (over
 * `node:fs`) and inside the Claude Code hook engine (over its own `$.fs`,
 * which has the same shape: `read` rejects when missing, `write` creates
 * parent directories, `exists` never rejects).
 */
export type { TextFs } from '../archive/file-store.js';

export const nodeFs: TextFs = {
  async read(path: string): Promise<string> {
    return fsp.readFile(path, 'utf-8');
  },

  async write(path: string, text: string): Promise<void> {
    await fsp.mkdir(nodePath.dirname(path), { recursive: true });
    await fsp.writeFile(path, text, 'utf-8');
  },

  async exists(path: string): Promise<boolean> {
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  },

  async list(dir: string): Promise<string[]> {
    try {
      return await fsp.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  },
};

/**
 * Joins path segments with forward slashes, without going through
 * `node:path` (which would use backslashes on Windows): the archive keys and
 * hook-relative paths this builds are meant to look the same on every host.
 */
export function joinPath(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/');
}
