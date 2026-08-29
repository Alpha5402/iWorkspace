import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import argon2 from 'argon2';
import { importPKCS8, importSPKI, jwtVerify, type JWTPayload, SignJWT } from 'jose';
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

export type UserSessionPrincipal = Readonly<{
  organizationId: string;
  sessionId: string;
  type: 'USER_SESSION';
  userId: string;
}>;

export type ProjectTokenPrincipal = Readonly<{
  organizationId: string;
  projectId: string;
  scopes: readonly ProjectTokenScope[];
  tokenId: string;
  type: 'PROJECT_TOKEN';
}>;

export type SystemPrincipal = Readonly<{
  organizationId: string;
  systemId: string;
  type: 'SYSTEM';
}>;

export type Principal = UserSessionPrincipal | ProjectTokenPrincipal | SystemPrincipal;

export function principalId(principal: Principal): string {
  switch (principal.type) {
    case 'USER_SESSION':
      return principal.sessionId;
    case 'PROJECT_TOKEN':
      return principal.tokenId;
    case 'SYSTEM':
      return principal.systemId;
  }
}

export function principalAuditMetadata(principal: Principal): Readonly<Record<string, string>> {
  return principal.type === 'USER_SESSION' ? { subjectUserId: principal.userId } : {};
}

export const organizationRoles = ['OWNER', 'ADMIN', 'MEMBER'] as const;
export type OrganizationRole = (typeof organizationRoles)[number];
export const projectRoles = ['MAINTAINER', 'REVIEWER', 'VIEWER'] as const;
export type ProjectRole = (typeof projectRoles)[number];
export const platformRoles = ['SUPER_ADMIN', 'ADMIN', 'USER'] as const;
export type PlatformRole = (typeof platformRoles)[number];
export const userAccountStatuses = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED'] as const;
export type UserAccountStatus = (typeof userAccountStatuses)[number];

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

export type JwtSigningKey = Readonly<{
  keyId: string;
  privateKeyPem: string;
}>;

export type JwtVerificationKey = Readonly<{
  keyId: string;
  publicKeyPem: string;
}>;

export type JwtKeySet = Readonly<{
  current: JwtSigningKey;
  verificationKeys: readonly JwtVerificationKey[];
}>;

const AccessTokenClaimsSchema = z.object({
  jti: z.uuid(),
  organizationId: z.uuid(),
  sessionId: z.uuid(),
  sub: z.uuid(),
  tokenType: z.literal('access'),
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>;
export type AccessTokenInput = Omit<AccessTokenClaims, 'jti' | 'tokenType'>;

const RefreshTokenClaimsSchema = z.object({
  familyId: z.uuid(),
  jti: z.uuid(),
  organizationId: z.uuid(),
  sessionId: z.uuid(),
  sub: z.uuid(),
  tokenType: z.literal('refresh'),
});
export type RefreshTokenClaims = z.infer<typeof RefreshTokenClaimsSchema>;
export type RefreshTokenInput = Omit<RefreshTokenClaims, 'tokenType'>;

const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

abstract class EdDsaJwtService {
  private readonly verificationKeys: ReadonlyMap<string, string>;

  protected constructor(
    private readonly keys: JwtKeySet,
    protected readonly issuer: string,
    protected readonly audience: string,
    private readonly tokenHeaderType: 'at+jwt' | 'rt+jwt',
  ) {
    if (
      keys.current.keyId.length === 0 ||
      !keys.verificationKeys.some((key) => key.keyId === keys.current.keyId)
    ) {
      throw new Error('JWT_CURRENT_KEY_MUST_BE_VERIFIABLE');
    }
    this.verificationKeys = new Map(
      keys.verificationKeys.map((key) => [key.keyId, key.publicKeyPem]),
    );
  }

  protected async signer(): Promise<Awaited<ReturnType<typeof importPKCS8>>> {
    return importPKCS8(this.keys.current.privateKeyPem, 'EdDSA');
  }

  protected currentSigningKeyId(): string {
    return this.keys.current.keyId;
  }

  protected protectedHeader(): Readonly<{ alg: 'EdDSA'; kid: string; typ: string }> {
    return { alg: 'EdDSA', kid: this.keys.current.keyId, typ: this.tokenHeaderType };
  }

  protected async verifyJwt(token: string): Promise<JWTPayload> {
    const result = await jwtVerify(
      token,
      async (protectedHeader) => {
        const keyId = protectedHeader.kid;
        const publicKeyPem = keyId === undefined ? undefined : this.verificationKeys.get(keyId);
        if (publicKeyPem === undefined) throw new Error('JWT_SIGNING_KEY_UNKNOWN');
        return importSPKI(publicKeyPem, 'EdDSA');
      },
      {
        algorithms: ['EdDSA'],
        audience: this.audience,
        issuer: this.issuer,
        requiredClaims: ['exp', 'iat', 'jti', 'sub'],
      },
    );
    if (result.protectedHeader.typ !== this.tokenHeaderType) {
      throw new Error('JWT_TOKEN_TYPE_INVALID');
    }
    return result.payload;
  }
}

export class AccessTokenService extends EdDsaJwtService {
  public constructor(keys: JwtKeySet, issuer: string, audience: string) {
    super(keys, issuer, audience, 'at+jwt');
  }

  public async issue(claims: AccessTokenInput, now = new Date()): Promise<string> {
    return new SignJWT({
      organizationId: claims.organizationId,
      sessionId: claims.sessionId,
      tokenType: 'access',
    })
      .setProtectedHeader(this.protectedHeader())
      .setJti(randomUUID())
      .setSubject(claims.sub)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt(Math.floor(now.getTime() / 1_000))
      .setExpirationTime(Math.floor(now.getTime() / 1_000) + ACCESS_TOKEN_TTL_SECONDS)
      .sign(await this.signer());
  }

  public async verify(token: string): Promise<AccessTokenClaims> {
    const payload = await this.verifyJwt(token);
    return AccessTokenClaimsSchema.parse({
      jti: payload.jti,
      organizationId: payload.organizationId,
      sessionId: payload.sessionId,
      sub: payload.sub,
      tokenType: payload.tokenType,
    });
  }
}

export class RefreshTokenService extends EdDsaJwtService {
  public constructor(keys: JwtKeySet, issuer: string, audience: string) {
    super(keys, issuer, audience, 'rt+jwt');
  }

  public get signingKeyId(): string {
    return this.currentSigningKeyId();
  }

  public async issue(claims: RefreshTokenInput, now = new Date()): Promise<string> {
    return new SignJWT({
      familyId: claims.familyId,
      organizationId: claims.organizationId,
      sessionId: claims.sessionId,
      tokenType: 'refresh',
    })
      .setProtectedHeader(this.protectedHeader())
      .setJti(claims.jti)
      .setSubject(claims.sub)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt(Math.floor(now.getTime() / 1_000))
      .setExpirationTime(Math.floor(now.getTime() / 1_000) + REFRESH_TOKEN_TTL_SECONDS)
      .sign(await this.signer());
  }

  public async verify(token: string): Promise<RefreshTokenClaims> {
    const payload = await this.verifyJwt(token);
    return RefreshTokenClaimsSchema.parse({
      familyId: payload.familyId,
      jti: payload.jti,
      organizationId: payload.organizationId,
      sessionId: payload.sessionId,
      sub: payload.sub,
      tokenType: payload.tokenType,
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
