export type SessionRow = Readonly<{
  created_at: Date;
  expires_at: Date;
  family_id: string;
  id: string;
  ip_address: string | null;
  last_seen_at: Date;
  organization_id: string;
  replaced_by: string | null;
  revoked_at: Date | null;
  signing_key_id: string;
  used_at: Date | null;
  user_agent: string | null;
}>;

export type SessionSummary = Readonly<{
  active: boolean;
  createdAt: string;
  current: boolean;
  expiresAt: string;
  familyId: string;
  ipAddress?: string;
  lastSeenAt: string;
  organizationId: string;
  sessionId: string;
  signingKeyId: string;
  userAgent?: string;
}>;

export function summarizeSessionFamilies(
  rows: readonly SessionRow[],
  databaseNow: Date,
  currentSessionId?: string,
): readonly SessionSummary[] {
  const families = new Map<string, SessionRow[]>();
  for (const row of rows) {
    const family = families.get(row.family_id) ?? [];
    family.push(row);
    families.set(row.family_id, family);
  }

  return [...families.values()]
    .map((familyRows) => {
      const ordered = familyRows.toSorted(
        (left, right) =>
          right.created_at.getTime() - left.created_at.getTime() || right.id.localeCompare(left.id),
      );
      const latest = ordered.find((row) => row.replaced_by === null) ?? ordered.at(0);
      const earliest = ordered.at(-1);
      if (latest === undefined || earliest === undefined) {
        throw new Error('SESSION_FAMILY_EMPTY');
      }
      return {
        active:
          latest.revoked_at === null && latest.used_at === null && latest.expires_at > databaseNow,
        createdAt: earliest.created_at.toISOString(),
        current: ordered.some((row) => row.id === currentSessionId),
        expiresAt: latest.expires_at.toISOString(),
        familyId: latest.family_id,
        ...(latest.ip_address === null ? {} : { ipAddress: latest.ip_address }),
        lastSeenAt: latest.last_seen_at.toISOString(),
        organizationId: latest.organization_id,
        sessionId: latest.id,
        signingKeyId: latest.signing_key_id,
        ...(latest.user_agent === null ? {} : { userAgent: latest.user_agent }),
      } satisfies SessionSummary;
    })
    .toSorted(
      (left, right) =>
        Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt) ||
        right.sessionId.localeCompare(left.sessionId),
    );
}
