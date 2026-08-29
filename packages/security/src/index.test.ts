import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { importPKCS8, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  AccessTokenService,
  decryptSecret,
  encryptSecret,
  hashPassword,
  hasPermission,
  issueOpaqueToken,
  principalAuditMetadata,
  principalId,
  RefreshTokenService,
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
    await expect(verifyPassword('not-an-argon-hash', password)).resolves.toBe(false);
    await expect(hashPassword('too short')).rejects.toThrow('PASSWORD_TOO_SHORT');
  });
});

describe('opaque tokens', () => {
  it('shows the secret once while keeping only a verifiable hash', () => {
    const token = issueOpaqueToken('iwpat', 'pepper');
    expect(token.token).toMatch(/^iwpat_/);
    expect(token.hash).not.toContain(token.token);
    expect(verifyOpaqueToken(token.token, token.hash, 'pepper')).toBe(true);
    expect(verifyOpaqueToken(`${token.token}x`, token.hash, 'pepper')).toBe(false);
    expect(verifyOpaqueToken(token.token, '00', 'pepper')).toBe(false);
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

describe('session JWTs', () => {
  it('uses independent audiences, keys and types for access and refresh credentials', async () => {
    const accessPair = generateKeyPairSync('ed25519');
    const refreshPair = generateKeyPairSync('ed25519');
    const accessKey = {
      keyId: 'access-v1',
      privateKeyPem: accessPair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      publicKeyPem: accessPair.publicKey.export({ format: 'pem', type: 'spki' }),
    };
    const refreshKey = {
      keyId: 'refresh-v1',
      privateKeyPem: refreshPair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      publicKeyPem: refreshPair.publicKey.export({ format: 'pem', type: 'spki' }),
    };
    const access = new AccessTokenService(
      { current: accessKey, verificationKeys: [accessKey] },
      'iworkspace',
      'iworkspace-access',
    );
    const refresh = new RefreshTokenService(
      { current: refreshKey, verificationKeys: [refreshKey] },
      'iworkspace',
      'iworkspace-refresh',
    );
    const identity = {
      organizationId: '5f114251-4f10-4de1-b4f8-589624a1900b',
      sessionId: '3247b66f-e7aa-49cc-b373-370e6b99115f',
      sub: 'a3604805-6d34-466f-b288-205358362f25',
    };
    const accessToken = await access.issue(identity);
    const refreshToken = await refresh.issue({
      ...identity,
      familyId: '66d5a6ff-9d80-481c-abf2-b3a69724d83e',
      jti: 'd1c54e35-18f7-4eed-b38e-80c244c2cc0a',
    });

    await expect(access.verify(accessToken)).resolves.toMatchObject({
      ...identity,
      tokenType: 'access',
    });
    await expect(refresh.verify(refreshToken)).resolves.toMatchObject({
      ...identity,
      tokenType: 'refresh',
    });
    await expect(access.verify(refreshToken)).rejects.toThrow();
    await expect(refresh.verify(accessToken)).rejects.toThrow();
  });

  it('keeps previous public keys in the verification window while signing with the current key', async () => {
    const oldPair = generateKeyPairSync('ed25519');
    const currentPair = generateKeyPairSync('ed25519');
    const oldKey = {
      keyId: 'access-v1',
      privateKeyPem: oldPair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      publicKeyPem: oldPair.publicKey.export({ format: 'pem', type: 'spki' }),
    };
    const currentKey = {
      keyId: 'access-v2',
      privateKeyPem: currentPair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      publicKeyPem: currentPair.publicKey.export({ format: 'pem', type: 'spki' }),
    };
    const claims = {
      organizationId: '5f114251-4f10-4de1-b4f8-589624a1900b',
      sessionId: '3247b66f-e7aa-49cc-b373-370e6b99115f',
      sub: 'a3604805-6d34-466f-b288-205358362f25',
    };
    const oldIssuer = new AccessTokenService(
      { current: oldKey, verificationKeys: [oldKey] },
      'iworkspace',
      'iworkspace-access',
    );
    const rotatingVerifier = new AccessTokenService(
      { current: currentKey, verificationKeys: [oldKey, currentKey] },
      'iworkspace',
      'iworkspace-access',
    );

    await expect(rotatingVerifier.verify(await oldIssuer.issue(claims))).resolves.toMatchObject(
      claims,
    );
    await expect(
      rotatingVerifier.verify(await rotatingVerifier.issue(claims)),
    ).resolves.toMatchObject(claims);
  });

  it('fails closed for unverifiable key sets, unknown key IDs, and the wrong JWT header type', async () => {
    const pair = generateKeyPairSync('ed25519');
    const key = {
      keyId: 'access-v1',
      privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      publicKeyPem: pair.publicKey.export({ format: 'pem', type: 'spki' }),
    };
    expect(
      () =>
        new AccessTokenService(
          { current: { ...key, keyId: '' }, verificationKeys: [key] },
          'iworkspace',
          'iworkspace-access',
        ),
    ).toThrow('JWT_CURRENT_KEY_MUST_BE_VERIFIABLE');
    expect(
      () =>
        new AccessTokenService(
          { current: key, verificationKeys: [] },
          'iworkspace',
          'iworkspace-access',
        ),
    ).toThrow('JWT_CURRENT_KEY_MUST_BE_VERIFIABLE');

    const otherPair = generateKeyPairSync('ed25519');
    const otherKey = {
      keyId: 'access-v2',
      privateKeyPem: otherPair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      publicKeyPem: otherPair.publicKey.export({ format: 'pem', type: 'spki' }),
    };
    const issuer = new AccessTokenService(
      { current: otherKey, verificationKeys: [otherKey] },
      'iworkspace',
      'iworkspace-access',
    );
    const verifier = new AccessTokenService(
      { current: key, verificationKeys: [key] },
      'iworkspace',
      'iworkspace-access',
    );
    const identity = {
      organizationId: '5f114251-4f10-4de1-b4f8-589624a1900b',
      sessionId: '3247b66f-e7aa-49cc-b373-370e6b99115f',
      sub: 'a3604805-6d34-466f-b288-205358362f25',
    };
    await expect(verifier.verify(await issuer.issue(identity))).rejects.toThrow(
      'JWT_SIGNING_KEY_UNKNOWN',
    );

    const now = Math.floor(Date.now() / 1_000);
    const wrongTypeToken = await new SignJWT({ ...identity, tokenType: 'access' })
      .setProtectedHeader({ alg: 'EdDSA', kid: key.keyId, typ: 'JWT' })
      .setJti('d1c54e35-18f7-4eed-b38e-80c244c2cc0a')
      .setSubject(identity.sub)
      .setIssuer('iworkspace')
      .setAudience('iworkspace-access')
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(await importPKCS8(key.privateKeyPem, 'EdDSA'));
    await expect(verifier.verify(wrongTypeToken)).rejects.toThrow('JWT_TOKEN_TYPE_INVALID');
  });
});

describe('authorization and csrf', () => {
  it('derives a stable audit identity from every principal kind', () => {
    const userSession = {
      organizationId: 'organization',
      sessionId: 'session',
      type: 'USER_SESSION' as const,
      userId: 'user',
    };

    expect(principalId(userSession)).toBe('session');
    expect(principalAuditMetadata(userSession)).toEqual({ subjectUserId: 'user' });
    expect(
      principalId({
        organizationId: 'organization',
        projectId: 'project',
        scopes: ['review:trigger'],
        tokenId: 'token',
        type: 'PROJECT_TOKEN',
      }),
    ).toBe('token');
    expect(
      principalId({ organizationId: 'organization', systemId: 'worker', type: 'SYSTEM' }),
    ).toBe('worker');
  });

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
