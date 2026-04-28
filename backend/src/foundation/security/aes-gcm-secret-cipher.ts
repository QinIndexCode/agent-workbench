import crypto from 'node:crypto';
import { SecretCipher } from './types';

function readKey(secretKey: string): Buffer {
  const normalized = secretKey.trim();
  if (!normalized) {
    throw new Error('backend_new security error: secret key must not be empty.');
  }

  const candidate = /^[0-9a-f]{64}$/i.test(normalized)
    ? Buffer.from(normalized, 'hex')
    : Buffer.from(normalized, 'base64');

  if (candidate.length !== 32) {
    throw new Error('backend_new security error: AES-256-GCM key must be 32 bytes.');
  }

  return candidate;
}

export class AesGcmSecretCipher implements SecretCipher {
  private readonly key: Buffer;

  constructor(secretKey: string) {
    this.key = readKey(secretKey);
  }

  encrypt(plainText: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(plainText, 'utf8')),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  decrypt(cipherText: string): string {
    const payload = Buffer.from(cipherText, 'base64');
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return plain.toString('utf8');
  }
}
