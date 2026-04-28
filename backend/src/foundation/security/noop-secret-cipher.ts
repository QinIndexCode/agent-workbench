import { SecretCipher } from './types';

export class NoopSecretCipher implements SecretCipher {
  encrypt(plainText: string): string {
    return plainText;
  }

  decrypt(cipherText: string): string {
    return cipherText;
  }
}
