import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BackendNewConfig } from '../config/types';
import { AesGcmSecretCipher } from './aes-gcm-secret-cipher';
import { NoopSecretCipher } from './noop-secret-cipher';
import { SecretCipher } from './types';

const GENERATED_SECRET_KEY_FILE = '.backend-new-secret.key';

function ensureLocalSecretKey(config: BackendNewConfig): string {
  const keyFile = path.join(config.paths.secretsDir, GENERATED_SECRET_KEY_FILE);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  if (fs.existsSync(keyFile)) {
    return fs.readFileSync(keyFile, 'utf8').trim();
  }

  const generatedKey = crypto.randomBytes(32).toString('base64');
  fs.writeFileSync(keyFile, generatedKey, { encoding: 'utf8', mode: 0o600 });
  return generatedKey;
}

export function createSecretCipher(
  config: BackendNewConfig,
  env: NodeJS.ProcessEnv = process.env
): SecretCipher {
  if (config.security.secretEncryption === 'none') {
    return new NoopSecretCipher();
  }

  const secretKey = env[config.security.secretKeyEnvVar] ?? ensureLocalSecretKey(config);

  return new AesGcmSecretCipher(secretKey);
}
