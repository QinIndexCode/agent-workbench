import fs from 'node:fs/promises';
import path from 'node:path';
import { StorageAdapter } from './types';

async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function isRetryableRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

async function renameWithRetry(tempPath: string, filePath: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rename(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRenameError(error) || attempt === 9) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function copyWithRetry(tempPath: string, filePath: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.copyFile(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRenameError(error) || attempt === 9) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function replaceFileWithRetry(tempPath: string, filePath: string): Promise<void> {
  try {
    await renameWithRetry(tempPath, filePath);
    return;
  } catch (error) {
    if (!isRetryableRenameError(error)) {
      throw error;
    }
  }

  await copyWithRetry(tempPath, filePath);
  try {
    await fs.unlink(tempPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }
}

export class FileStorageAdapter implements StorageAdapter {
  private readonly mutationChains = new Map<string, Promise<void>>();

  private async runExclusive(filePath: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.mutationChains.get(filePath) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(operation);
    this.mutationChains.set(filePath, next);
    try {
      await next;
    } finally {
      if (this.mutationChains.get(filePath) === next) {
        this.mutationChains.delete(filePath);
      }
    }
  }

  async ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(dirPath: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries
        .filter(entry => entry.isFile())
        .map(entry => path.join(dirPath, entry.name));
    } catch {
      return [];
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async deleteDir(dirPath: string): Promise<void> {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async stat(filePath: string): Promise<{
    isFile: boolean;
    modifiedAt: number;
  }> {
    const info = await fs.stat(filePath);
    return {
      isFile: info.isFile(),
      modifiedAt: info.mtimeMs
    };
  }

  async readText(filePath: string, encoding: BufferEncoding = 'utf8'): Promise<string> {
    return fs.readFile(filePath, encoding);
  }

  async readJson<T>(filePath: string, encoding: BufferEncoding = 'utf8'): Promise<T> {
    const text = await this.readText(filePath, encoding);
    return JSON.parse(stripBom(text)) as T;
  }

  async writeText(
    filePath: string,
    content: string,
    encoding: BufferEncoding = 'utf8'
  ): Promise<void> {
    await this.runExclusive(filePath, async () => {
      await ensureParentDir(filePath);
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      await fs.writeFile(tempPath, content, encoding);
      await replaceFileWithRetry(tempPath, filePath);
    });
  }

  async appendText(
    filePath: string,
    content: string,
    encoding: BufferEncoding = 'utf8'
  ): Promise<void> {
    await this.runExclusive(filePath, async () => {
      await ensureParentDir(filePath);
      await fs.appendFile(filePath, content, encoding);
    });
  }

  async writeJson<T>(filePath: string, data: T, spacing = 2): Promise<void> {
    await this.writeText(filePath, `${JSON.stringify(data, null, spacing)}\n`);
  }

  async appendJsonLine(filePath: string, data: unknown): Promise<void> {
    await this.appendText(filePath, `${JSON.stringify(data)}\n`);
  }
}
