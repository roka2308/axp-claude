import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from './build-info';

describe('schema version', () => {
  it('equals the number of committed migrations', () => {
    const journal = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../db/migrations/meta/_journal.json'), 'utf8'),
    ) as { entries: unknown[] };

    // A new migration without a bumped version fails here, not in a footer
    // nobody reads.
    expect(SCHEMA_VERSION).toBe(String(journal.entries.length));
  });
});
