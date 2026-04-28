export interface SecretCipher {
  encrypt(plainText: string): string;
  decrypt(cipherText: string): string;
}

export interface SecretCipherFactory {
  createFromEnv(env?: NodeJS.ProcessEnv): SecretCipher;
}
