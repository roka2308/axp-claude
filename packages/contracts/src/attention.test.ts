import { describe, expect, it } from 'vitest';
import { ATTENTION_KINDS } from './attention';
import { JOB_PAYLOAD_SCHEMAS } from './jobs';

describe('attention center contract', () => {
  it('knows operational kinds only - nothing about how a metric moved', () => {
    // Changing this list is a product decision (Master Spec §15, §29): an
    // analytics alert must not slip in as "just another kind".
    expect([...ATTENTION_KINDS]).toEqual([
      'report_failed',
      'report_recipient_without_access',
      'share_expiring',
      'mapping_review',
      'inactivity_review',
    ]);
    for (const kind of ATTENTION_KINDS) {
      expect(kind).not.toMatch(/metric|threshold|anomal|drop|spike|value/);
    }
  });
});

describe('job payloads', () => {
  it('carry ids, and refuse anything else', () => {
    expect(JOB_PAYLOAD_SCHEMAS['report.deliver'].safeParse({ runId: 'r-1' }).success).toBe(true);
    expect(
      JOB_PAYLOAD_SCHEMAS['report.deliver'].safeParse({ runId: 'r-1', rows: [{ visits: 3 }] })
        .success,
    ).toBe(false);
  });
});
