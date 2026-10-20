import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from './load';

/**
 * `MATOMO_ALLOWED_PRIVATE_HOSTS`: internal Matomo servers named by the
 * operator. Only plain host names and address literals are accepted - an entry
 * that could match more than one host is a configuration error at startup.
 */

const KEY = Buffer.alloc(32, 1).toString('base64');
const BASE: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  APP_ENV: 'test',
  API_PUBLIC_URL: 'http://localhost:4000',
  WEB_PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'mysql://user:pass@127.0.0.1:3307/axp_test',
  SESSION_SECRET: KEY,
  CREDENTIAL_ENCRYPTION_KEY: KEY,
};

const hostsFrom = (value?: string) =>
  loadConfig({ ...BASE, ...(value === undefined ? {} : { MATOMO_ALLOWED_PRIVATE_HOSTS: value }) })
    .matomo.allowedPrivateHosts;

describe('internal Matomo hosts', () => {
  it('is empty unless the operator names hosts', () => {
    expect(hostsFrom()).toEqual([]);
    expect(hostsFrom('')).toEqual([]);
  });

  it('reads names and address literals, case-insensitively and trimmed', () => {
    expect(hostsFrom(' Matomo.Intern.Example. , 10.20.30.40,fd12:3456::10 ')).toEqual([
      'matomo.intern.example',
      '10.20.30.40',
      'fd12:3456::10',
    ]);
  });

  it('refuses anything that could match more than one host', () => {
    for (const entry of [
      '*.intern.example',
      '10.0.0.0/8',
      'https://matomo.intern.example',
      'matomo.intern.example:8443',
      'matomo intern',
    ]) {
      expect(() => hostsFrom(entry), entry).toThrow(ConfigurationError);
    }
  });
});
