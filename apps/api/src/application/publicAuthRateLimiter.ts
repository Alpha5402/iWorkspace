import { createHmac } from 'node:crypto';

import { type DeliveryDatabase, getDatabaseNow } from '@delivery/database';

import { HttpError } from '../errors.js';

const RATE_LIMIT_WINDOW_MILLISECONDS = 60 * 60 * 1_000;

export class PublicAuthRateLimiter {
  public constructor(
    private readonly database: DeliveryDatabase,
    private readonly tokenPepper: string,
  ) {}

  public async consume(
    input: Readonly<{
      identity: string;
      identityDimension: 'EMAIL' | 'TOKEN';
      ipAddress: string;
      maximumHits: number;
      operation: 'ACCEPT_ADMINISTRATOR_INVITATION' | 'LOGIN' | 'REGISTER' | 'RESEND_VERIFICATION';
    }>,
  ): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      const databaseNow = await getDatabaseNow(transaction);
      const windowStartedAt = new Date(
        Math.floor(databaseNow.getTime() / RATE_LIMIT_WINDOW_MILLISECONDS) *
          RATE_LIMIT_WINDOW_MILLISECONDS,
      );
      const expiresAt = new Date(windowStartedAt.getTime() + RATE_LIMIT_WINDOW_MILLISECONDS * 2);
      await transaction
        .deleteFrom('public_rate_limits')
        .where('expires_at', '<', databaseNow)
        .execute();
      for (const [dimension, value] of [
        [
          `${input.operation}:${input.identityDimension}`,
          input.identity.trim().toLocaleLowerCase(),
        ],
        [`${input.operation}:IP`, input.ipAddress],
      ] as const) {
        const keyHash = createHmac('sha256', this.tokenPepper).update(value).digest('hex');
        const bucket = await transaction
          .insertInto('public_rate_limits')
          .values({
            dimension,
            expires_at: expiresAt,
            hit_count: 1,
            key_hash: keyHash,
            window_started_at: windowStartedAt,
          })
          .onConflict((conflict) =>
            conflict
              .columns(['dimension', 'key_hash', 'window_started_at'])
              .doUpdateSet((expression) => ({
                hit_count: expression('public_rate_limits.hit_count', '+', 1),
              })),
          )
          .returning('hit_count')
          .executeTakeFirstOrThrow();
        if (bucket.hit_count > input.maximumHits) {
          throw new HttpError(
            429,
            'PUBLIC_AUTH_RATE_LIMITED',
            'Too many authentication requests. Try again later.',
          );
        }
      }
    });
  }
}
