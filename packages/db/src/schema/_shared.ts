import { char, datetime } from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';
import { ID_LENGTH } from '../ids';

/** Primary key column shape used by every table. */
export const idColumn = () => char({ length: ID_LENGTH });

/**
 * All system timestamps are UTC (Master Spec §19).
 *
 * `datetime` is used rather than `timestamp`: MySQL's TIMESTAMP converts values
 * against the session time zone, which would make stored instants depend on
 * connection settings. Millisecond precision keeps ordering stable.
 */
export const utcTimestamp = () => datetime({ mode: 'date', fsp: 3 });

export const createdAt = () =>
  utcTimestamp()
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`);

/**
 * `updated_at` is a storage-layer stamp, not domain time: it records when a row
 * was written and is never used for business decisions, so it reads the wall
 * clock directly rather than the injected Clock.
 */
export const updatedAt = () =>
  utcTimestamp()
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`)
    // eslint-disable-next-line no-restricted-syntax -- storage timestamp, see above
    .$onUpdate(() => new Date());
