export interface StorageAdapter {
  ensureDir(dirPath: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  listFiles(dirPath: string): Promise<string[]>;
  deleteFile(filePath: string): Promise<void>;
  deleteDir(dirPath: string): Promise<void>;
  stat(filePath: string): Promise<{
    isFile: boolean;
    modifiedAt: number;
  }>;
  readText(filePath: string, encoding?: BufferEncoding): Promise<string>;
  readJson<T>(filePath: string, encoding?: BufferEncoding): Promise<T>;
  writeText(filePath: string, content: string, encoding?: BufferEncoding): Promise<void>;
  appendText(filePath: string, content: string, encoding?: BufferEncoding): Promise<void>;
  writeJson<T>(filePath: string, data: T, spacing?: number): Promise<void>;
  appendJsonLine(filePath: string, data: unknown): Promise<void>;
}
