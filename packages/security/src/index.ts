import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import argon2 from 'argon2';
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

const TOKEN_BYTES = 32;
const GCM_IV_BYTES = 12;

export const projectTokenScopes = [
  'review:trigger',
  'review:read',
  'project:read',
  'artifact:read',
] as const;
export type ProjectTokenScope = (typeof projectTokenScopes)[number];

export const organizationRoles = ['OWNER', 'ADMIN', 'MEMBER'] as const;
export type OrganizationRole = (typeof organizationRoles)[number];
export const projectRoles = ['MAINTAINER', 'REVIEWER', 'VIEWER'] as const;
export type ProjectRole = (typeof projectRoles)[number];

export type Permission =
  'organization:manage' | 'project:manage' | 'review:trigger' | 'review:read' | 'artifact:read';

const projectRolePermissions: Readonly<Record<ProjectRole, readonly Permission[]>> = {
  MAINTAINER: ['project:manage', 'review:trigger', 'review:read', 'artifact:read'],
  REVIEWER: ['review:trigger', 'review:read', 'artifact:read'],
  VIEWER: ['review:read', 'artifact:read'],
};

export function hasPermission(
  input: Readonly<{
    organizationRole: OrganizationRole;
    permission: Permission;
    projectRole?: ProjectRole;
  }>,
): boolean {
  if (input.organizationRole === 'OWNER' || input.organizationRole === 'ADMIN') return true;
  return input.projectRole === undefined
    ? false
    : projectRolePermissions[input.projectRole].includes(input.permission);
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error('PASSWORD_TOO_SHORT');
  return argon2.hash(password, {
    hashLength: 32,
    memoryCost: 65_536,
    parallelism: 1,
    timeCost: 3,
    type: argon2.argon2id,
  });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    return false;
  }
}

export type IssuedOpaqueToken = Readonly<{
  hash: string;
  prefix: string;
  token: string;
}>;

export function hashOpaqueToken(token: string, pepper: string): string {
  return createHmac('sha256', pepper).update(token).digest('hex');
}

export function issueOpaqueToken(prefix: string, pepper: string): IssuedOpaqueToken {
  const secret = randomBytes(TOKEN_BYTES).toString('base64url');
  const token = `${prefix}_${secret}`;
  return { hash: hashOpaqueToken(token, pepper), prefix: token.slice(0, 12), token };
}

export function verifyOpaqueToken(token: string, expectedHash: string, pepper: string): boolean {
  const actual = Buffer.from(hashOpaqueToken(token, pepper), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type EnvelopeCiphertext = Readonly<{
  aad: string;
  ciphertext: string;
  encryptedDek: string;
  iv: string;
  keyVersion: number;
  tag: string;
  wrapIv: string;
  wrapTag: string;
}>;

function assertAes256Key(key: Buffer): void {
  if (key.byteLength !== 32) throw new Error('KEK_MUST_BE_32_BYTES');
}

function encryptAesGcm(
  plaintext: Buffer,
  key: Buffer,
  aad: Buffer,
): Readonly<{
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}> {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decryptAesGcm(
  encrypted: Readonly<{ ciphertext: Buffer; iv: Buffer; tag: Buffer }>,
  key: Buffer,
  aad: Buffer,
): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(encrypted.tag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
}

export function encryptSecret(
  input: Readonly<{
    aad: string;
    keyEncryptionKey: Buffer;
    keyVersion: number;
    plaintext: string;
  }>,
): EnvelopeCiphertext {
  assertAes256Key(input.keyEncryptionKey);
  const aad = Buffer.from(input.aad, 'utf8');
  const dek = randomBytes(32);
  const encryptedValue = encryptAesGcm(Buffer.from(input.plaintext, 'utf8'), dek, aad);
  const wrapAad = Buffer.from(`dek:${input.keyVersion}:${input.aad}`, 'utf8');
  const wrappedDek = encryptAesGcm(dek, input.keyEncryptionKey, wrapAad);
  return {
    aad: input.aad,
    ciphertext: encryptedValue.ciphertext.toString('base64'),
    encryptedDek: wrappedDek.ciphertext.toString('base64'),
    iv: encryptedValue.iv.toString('base64'),
    keyVersion: input.keyVersion,
    tag: encryptedValue.tag.toString('base64'),
    wrapIv: wrappedDek.iv.toString('base64'),
    wrapTag: wrappedDek.tag.toString('base64'),
  };
}

export function decryptSecret(envelope: EnvelopeCiphertext, keyEncryptionKey: Buffer): string {
  assertAes256Key(keyEncryptionKey);
  const wrapAad = Buffer.from(`dek:${envelope.keyVersion}:${envelope.aad}`, 'utf8');
  const dek = decryptAesGcm(
    {
      ciphertext: Buffer.from(envelope.encryptedDek, 'base64'),
      iv: Buffer.from(envelope.wrapIv, 'base64'),
      tag: Buffer.from(envelope.wrapTag, 'base64'),
    },
    keyEncryptionKey,
    wrapAad,
  );
  return decryptAesGcm(
    {
      ciphertext: Buffer.from(envelope.ciphertext, 'base64'),
      iv: Buffer.from(envelope.iv, 'base64'),
      tag: Buffer.from(envelope.tag, 'base64'),
    },
    dek,
    Buffer.from(envelope.aad, 'utf8'),
  ).toString('utf8');
}

const AccessTokenClaimsSchema = z.object({
  organizationId: z.uuid(),
  sessionId: z.uuid(),
  sub: z.uuid(),
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>;

export class AccessTokenService {
  public constructor(
    private readonly privateKeyPem: string,
    private readonly publicKeyPem: string,
    private readonly issuer: string,
    private readonly audience: string,
  ) {}

  public async issue(claims: AccessTokenClaims, now = new Date()): Promise<string> {
    const key = await importPKCS8(this.privateKeyPem, 'EdDSA');
    return new SignJWT({ organizationId: claims.organizationId, sessionId: claims.sessionId })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt(Math.floor(now.getTime() / 1_000))
      .setExpirationTime(Math.floor(now.getTime() / 1_000) + 600)
      .sign(key);
  }

  public async verify(token: string): Promise<AccessTokenClaims> {
    const key = await importSPKI(this.publicKeyPem, 'EdDSA');
    const result = await jwtVerify(token, key, {
      algorithms: ['EdDSA'],
      audience: this.audience,
      issuer: this.issuer,
    });
    return AccessTokenClaimsSchema.parse({
      organizationId: result.payload.organizationId,
      sessionId: result.payload.sessionId,
      sub: result.payload.sub,
    });
  }
}

export function validateCsrf(
  input: Readonly<{
    allowedOrigin: string;
    csrfCookie?: string | undefined;
    csrfHeader?: string | undefined;
    origin?: string | undefined;
  }>,
): boolean {
  if (
    input.origin !== input.allowedOrigin ||
    input.csrfCookie === undefined ||
    input.csrfHeader === undefined
  ) {
    return false;
  }
  const cookie = Buffer.from(input.csrfCookie);
  const header = Buffer.from(input.csrfHeader);
  return cookie.length === header.length && timingSafeEqual(cookie, header);
}
