import { describe, expect, it } from 'vitest';

import { summarizeSessionFamilies, type SessionRow } from './sessionSummaries.js';

describe('session family summaries', () => {
  it('uses the unreplaced leaf instead of UUID ordering when timestamps tie', () => {
    const common = {
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      expires_at: new Date('2026-02-01T00:00:00.000Z'),
      family_id: 'family',
      ip_address: null,
      last_seen_at: new Date('2026-01-01T00:00:00.000Z'),
      organization_id: 'organization',
      revoked_at: null,
      signing_key_id: 'key-v1',
      user_agent: null,
    } as const;
    const rows: readonly SessionRow[] = [
      {
        ...common,
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        replaced_by: 'leaf',
        used_at: new Date(),
      },
      { ...common, id: '00000000-0000-4000-8000-000000000001', replaced_by: null, used_at: null },
    ];

    expect(summarizeSessionFamilies(rows, new Date('2026-01-02T00:00:00.000Z'))).toMatchObject([
      { active: true, sessionId: '00000000-0000-4000-8000-000000000001' },
    ]);
  });
});
