import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AccessTokenService,
  decryptSecret,
  encryptSecret,
  hashPassword,
  hasPermission,
  issueOpaqueToken,
  validateCsrf,
  verifyOpaqueToken,
  verifyPassword,
} from './index.js';

describe('password credentials', () => {
  it('hashes with argon2id and verifies without exposing the password', async () => {
    const password = 'correct horse battery staple';
    const passwordHash = await hashPassword(password);
    expect(passwordHash).toContain('$argon2id$');
    await expect(verifyPassword(passwordHash, password)).resolves.toBe(true);
    await expect(verifyPassword(passwordHash, 'incorrect password')).resolves.toBe(false);
  });
});

describe('opaque tokens', () => {
  it('shows the secret once while keeping only a verifiable hash', () => {
    const token = issueOpaqueToken('iwpat', 'pepper');
    expect(token.token).toMatch(/^iwpat_/);
    expect(token.hash).not.toContain(token.token);
    expect(verifyOpaqueToken(token.token, token.hash, 'pepper')).toBe(true);
    expect(verifyOpaqueToken(`${token.token}x`, token.hash, 'pepper')).toBe(false);
  });
});

describe('envelope encryption', () => {
  it('binds ciphertext and wrapped DEK to the tenant AAD', () => {
    const keyEncryptionKey = randomBytes(32);
    const encrypted = encryptSecret({
      aad: 'project:project-1:deepseek',
      keyEncryptionKey,
      keyVersion: 1,
      plaintext: 'secret-value',
    });
    expect(decryptSecret(encrypted, keyEncryptionKey)).toBe('secret-value');
    expect(() => decryptSecret({ ...encrypted, aad: 'project:other' }, keyEncryptionKey)).toThrow();
  });
});

describe('access token', () => {
  it('issues and verifies a short-lived EdDSA JWT', async () => {
    const pair = generateKeyPairSync('ed25519');
    const service = new AccessTokenService(
      pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      pair.publicKey.export({ format: 'pem', type: 'spki' }),
      'iworkspace',
      'iworkspace-web',
    );
    const claims = {
      organizationId: '5f114251-4f10-4de1-b4f8-589624a1900b',
      sessionId: '3247b66f-e7aa-49cc-b373-370e6b99115f',
      sub: 'a3604805-6d34-466f-b288-205358362f25',
    };
    const token = await service.issue(claims);
    await expect(service.verify(token)).resolves.toEqual(claims);
  });
});

describe('authorization and csrf', () => {
  it('keeps project management with maintainers and organization admins', () => {
    expect(
      hasPermission({
        organizationRole: 'MEMBER',
        permission: 'project:manage',
        projectRole: 'MAINTAINER',
      }),
    ).toBe(true);
    expect(
      hasPermission({
        organizationRole: 'MEMBER',
        permission: 'project:manage',
        projectRole: 'REVIEWER',
      }),
    ).toBe(false);
    expect(hasPermission({ organizationRole: 'ADMIN', permission: 'organization:manage' })).toBe(
      true,
    );
  });

  it('requires the allowed origin and matching double-submit token', () => {
    expect(
      validateCsrf({
        allowedOrigin: 'https://app.example',
        csrfCookie: 'csrf',
        csrfHeader: 'csrf',
        origin: 'https://app.example',
      }),
    ).toBe(true);
    expect(
      validateCsrf({
        allowedOrigin: 'https://app.example',
        csrfCookie: 'csrf',
        csrfHeader: 'different',
        origin: 'https://app.example',
      }),
    ).toBe(false);
  });
});
