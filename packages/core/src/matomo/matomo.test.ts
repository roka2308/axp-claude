import { describe, expect, it } from 'vitest';
import {
  AppError,
  deriveCompatibility,
  hasCapability,
  hasNumericValue,
  type CapabilityProbeResult,
} from '@axp/contracts';
import { fixedClock } from '../clock';
import { SecretBox } from '../secret-box';
import { isInternalNetworkAddress, isPrivateAddress, assertSafeOutboundUrl } from './url-guard';
import { MockMatomoAdapter, scenarioFromUrl } from './mock-adapter';
import type { ResolvedQuery } from './connector';

const clock = fixedClock(new Date('2026-09-20T10:00:00.000Z'));
const adapter = new MockMatomoAdapter(clock);

function connection(scenario: string) {
  return { connectionId: 'c1', baseUrl: `mock://${scenario}`, token: 'a-long-enough-token' };
}

function query(overrides: Partial<ResolvedQuery> = {}): ResolvedQuery {
  return {
    kind: 'scalar',
    tenantId: 't1',
    projectId: 'p1',
    siteId: 's1',
    connectionId: 'c1',
    matomoSiteId: 1,
    siteTimezone: 'Europe/Berlin',
    semanticVersionIds: ['v-visits'],
    sourceMetrics: [{ semanticVersionId: 'v-visits', sourceMetric: 'visits', decimals: 0 }],
    dimensions: [],
    timeRange: { preset: 'custom', from: '2026-09-01', to: '2026-09-07' },
    fixedFilters: [],
    permissionContextId: 'ctx',
    ...overrides,
  };
}

describe('compatibility derivation', () => {
  const probe = (capability: string, state: 'available' | 'unavailable'): CapabilityProbeResult =>
    ({ capability, state }) as CapabilityProbeResult;

  it('is decided by capabilities, never by the version string', () => {
    // A certified version with a broken technical probe is still unsupported.
    expect(
      deriveCompatibility([probe('url_reachable', 'unavailable')], { versionCertified: true }),
    ).toBe('unsupported');
  });

  it('reports limitations when a core capability is missing but the rest works', () => {
    expect(
      deriveCompatibility(
        [probe('url_reachable', 'available'), probe('page_ranking', 'unavailable')],
        { versionCertified: true },
      ),
    ).toBe('supported_with_limitations');
  });

  it('separates "works" from "tested": an uncertified version is not unsupported', () => {
    expect(
      deriveCompatibility([probe('url_reachable', 'available'), probe('visits', 'available')], {
        versionCertified: false,
      }),
    ).toBe('technically_compatible_not_certified');
  });
});

describe('mock adapter', () => {
  it('maps a URL onto its scenario, falling back to the healthy one', () => {
    expect(scenarioFromUrl('mock://limited')).toBe('limited');
    expect(scenarioFromUrl('mock://nonsense')).toBe('default');
    expect(scenarioFromUrl('https://matomo.example')).toBe('default');
  });

  it('is deterministic: the same query always yields the same numbers', async () => {
    const first = await adapter.execute(connection('default'), query());
    const second = await adapter.execute(connection('default'), query());
    expect(first).toEqual(second);
  });

  it('produces different values for different periods', async () => {
    const week1 = await adapter.execute(connection('default'), query());
    const week2 = await adapter.execute(
      connection('default'),
      query({ timeRange: { preset: 'custom', from: '2026-08-01', to: '2026-08-07' } }),
    );
    expect(week1).not.toEqual(week2);
  });

  it('reports a measured zero as a value, not as a gap', async () => {
    const result = await adapter.execute(connection('zero'), query());
    expect(result.kind).toBe('scalar');
    if (result.kind !== 'scalar') return;

    const value = result.metrics[0]!.value;
    expect(value.state).toBe('zero');
    expect(hasNumericValue(value)).toBe(true);
  });

  it('distinguishes an empty result from a zero one', async () => {
    const result = await adapter.execute(connection('empty'), query());
    if (result.kind !== 'scalar') throw new Error('expected a scalar result');
    expect(result.metrics[0]!.value.state).toBe('empty');
  });

  it('refuses every call when the source is unreachable', async () => {
    await expect(adapter.execute(connection('unavailable'), query())).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.category === 'source_unavailable',
    );
  });

  it('blocks only the affected use case when a core capability is missing', async () => {
    // A ranking query fails on the "limited" scenario...
    await expect(
      adapter.execute(
        connection('limited'),
        query({ kind: 'breakdown', dimensions: ['page_url'] }),
      ),
    ).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.category === 'capability_unsupported',
    );

    // ...while visits still work on the same connection.
    const scalar = await adapter.execute(connection('limited'), query());
    expect(scalar.kind).toBe('scalar');
  });

  it('degrades gracefully when only optional capabilities are missing', async () => {
    const fingerprint = await adapter.getCapabilityFingerprint(connection('degraded'));
    expect(fingerprint.compatibility).toBe('supported');
    expect(hasCapability(fingerprint, 'visits')).toBe(true);
    expect(hasCapability(fingerprint, 'events')).toBe(false);
    expect(fingerprint.limitationKeys.length).toBeGreaterThan(0);
  });

  it('returns a comparison series aligned by position with the primary one', async () => {
    const result = await adapter.execute(
      connection('default'),
      query({
        kind: 'series',
        granularity: 'day',
        comparisonRange: { from: '2026-08-25', to: '2026-08-31' },
      }),
    );

    if (result.kind !== 'series') throw new Error('expected a series result');
    const series = result.series[0]!;
    expect(series.points).toHaveLength(7);
    expect(series.comparisonPoints).toHaveLength(7);
  });

  it('rejects a token that is obviously not one', async () => {
    const result = await adapter.testConnection({ baseUrl: 'mock://default', token: 'short' });
    expect(result.authenticated).toBe(false);
    expect(result.compatibility).toBe('unsupported');
  });
});

describe('SSRF guard', () => {
  const strict = { allowPrivateNetwork: false };

  it('classifies private and loopback ranges', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('refuses a non-http scheme', async () => {
    await expect(assertSafeOutboundUrl('file:///etc/passwd', strict)).rejects.toThrow(AppError);
    await expect(assertSafeOutboundUrl('gopher://example.com', strict)).rejects.toThrow(AppError);
  });

  it('refuses credentials embedded in the URL', async () => {
    // They would end up in the stored connection and in any log of it.
    await expect(
      assertSafeOutboundUrl('https://user:secret@matomo.example', strict),
    ).rejects.toThrow(AppError);
  });

  it('refuses the cloud metadata address and private literals', async () => {
    await expect(assertSafeOutboundUrl('http://169.254.169.254/latest', strict)).rejects.toThrow(
      AppError,
    );
    await expect(assertSafeOutboundUrl('http://192.168.0.10/matomo', strict)).rejects.toThrow(
      AppError,
    );
  });

  it('allows a local Matomo only where private networks are explicitly permitted', async () => {
    await expect(assertSafeOutboundUrl('http://127.0.0.1:8080', strict)).rejects.toThrow(AppError);
    await expect(
      assertSafeOutboundUrl('http://127.0.0.1:8080', { allowPrivateNetwork: true }),
    ).resolves.toBeInstanceOf(URL);
  });
});

describe('SSRF guard: internal Matomo servers named by the operator', () => {
  const dns: Record<string, string[]> = {
    'matomo.intern.example': ['10.20.30.40'],
    'analytics.intern.example': ['10.20.30.41'],
    'matomo-v6.intern.example': ['fd12:3456::10'],
    'loop.intern.example': ['127.0.0.1'],
    'linklocal.intern.example': ['169.254.10.10'],
    'metadata.intern.example': ['169.254.169.254'],
    'public.example': ['93.184.216.34'],
  };
  const named = (hosts: string[]) => ({
    allowPrivateNetwork: false,
    allowedPrivateHosts: hosts,
    resolve: async (hostname: string) => dns[hostname] ?? [],
  });

  it('lets a named host reach the company network', async () => {
    const options = named(['matomo.intern.example', 'matomo-v6.intern.example']);
    await expect(
      assertSafeOutboundUrl('https://matomo.intern.example/', options),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeOutboundUrl('https://MATOMO.Intern.Example:8443/', options),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeOutboundUrl('https://matomo-v6.intern.example/', options),
    ).resolves.toBeInstanceOf(URL);
  });

  it('keeps every host that was not named refused', async () => {
    const options = named(['matomo.intern.example']);
    await expect(
      assertSafeOutboundUrl('https://analytics.intern.example/', options),
    ).rejects.toMatchObject({ code: 'private_address' });
    await expect(assertSafeOutboundUrl('http://10.20.30.40/', options)).rejects.toMatchObject({
      code: 'private_address',
    });
  });

  it('accepts an address literal only when that literal is named', async () => {
    const options = named(['10.20.30.40']);
    await expect(assertSafeOutboundUrl('http://10.20.30.40/', options)).resolves.toBeInstanceOf(
      URL,
    );
    await expect(assertSafeOutboundUrl('http://10.20.30.41/', options)).rejects.toMatchObject({
      code: 'private_address',
    });
  });

  it('never lets a named host point at this machine, link-local or a metadata service', async () => {
    const options = named([
      'loop.intern.example',
      'linklocal.intern.example',
      'metadata.intern.example',
    ]);
    await expect(
      assertSafeOutboundUrl('https://loop.intern.example/', options),
    ).rejects.toMatchObject({ code: 'private_address' });
    await expect(
      assertSafeOutboundUrl('https://linklocal.intern.example/', options),
    ).rejects.toMatchObject({ code: 'private_address' });
    await expect(
      assertSafeOutboundUrl('https://metadata.intern.example/', options),
    ).rejects.toMatchObject({ code: 'blocked_address' });
    await expect(
      assertSafeOutboundUrl('https://localhost/', named(['localhost'])),
    ).rejects.toMatchObject({ code: 'blocked_host' });
  });

  it('changes nothing for public hosts', async () => {
    await expect(
      assertSafeOutboundUrl('https://public.example/', named([])),
    ).resolves.toBeInstanceOf(URL);
  });

  it('separates internal network ranges from the rest of the private ones', () => {
    for (const address of [
      '10.0.0.1',
      '172.20.1.1',
      '192.168.5.5',
      '100.64.1.1',
      'fd00::1',
      '::ffff:10.1.1.1',
    ]) {
      expect(isInternalNetworkAddress(address), address).toBe(true);
    }
    for (const address of [
      '127.0.0.1',
      '169.254.1.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      'fe80::1',
      '8.8.8.8',
    ]) {
      expect(isInternalNetworkAddress(address), address).toBe(false);
    }
  });
});

describe('credential sealing', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const box = new SecretBox({ key });

  it('round-trips a secret without storing it in readable form', () => {
    const sealed = box.seal('token_auth_value');
    expect(sealed.ciphertext).not.toContain('token_auth_value');
    expect(box.open(sealed)).toBe('token_auth_value');
  });

  it('produces a different ciphertext every time', () => {
    // A deterministic ciphertext would leak that two connections share a token.
    expect(box.seal('same').ciphertext).not.toBe(box.seal('same').ciphertext);
  });

  it('refuses to open a tampered record rather than returning garbage', () => {
    const sealed = box.seal('token');
    const tampered = { ...sealed, ciphertext: Buffer.from('nonsense').toString('base64') };
    expect(() => box.open(tampered)).toThrow(AppError);
  });

  it('refuses a key of the wrong length', () => {
    expect(() => new SecretBox({ key: Buffer.alloc(16).toString('base64') })).toThrow(AppError);
  });

  it('compares a candidate without revealing the secret', () => {
    const sealed = box.seal('correct-token');
    expect(box.matches(sealed, 'correct-token')).toBe(true);
    expect(box.matches(sealed, 'wrong-token')).toBe(false);
  });
});
