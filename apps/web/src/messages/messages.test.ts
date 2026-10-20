import { readFileSync } from 'node:fs';
import path from 'node:path';
import { globSync } from 'tinyglobby';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

/**
 * The message catalogues, checked for the failures that do not announce
 * themselves.
 *
 * next-intl reads a dot as nesting, so a key named `x.action` is unreachable:
 * `t('widget.x.action')` walks into the string `x` and finds nothing. The
 * lookups were guarded with `t.has()`, so the text simply never appeared - for
 * four widget actions, since Phase 1. A missing translation fails just as
 * quietly. Both get a test.
 */

type Messages = Record<string, unknown>;

const root = path.resolve(__dirname, '../..');
const repo = path.resolve(root, '../..');

const catalogues = {
  de: JSON.parse(readFileSync(path.join(__dirname, 'de.json'), 'utf8')) as Messages,
  en: JSON.parse(readFileSync(path.join(__dirname, 'en.json'), 'utf8')) as Messages,
};

function keysOf(messages: Messages, prefix = ''): string[] {
  return Object.entries(messages).flatMap(([key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object' ? keysOf(value as Messages, full) : [full];
  });
}

function segmentsOf(messages: Messages, trail: string[] = []): string[][] {
  return Object.entries(messages).flatMap(([key, value]) => {
    const here = [...trail, key];
    return [
      here,
      ...(value && typeof value === 'object' ? segmentsOf(value as Messages, here) : []),
    ];
  });
}

describe('message catalogues', () => {
  it('never use a dot inside a key, which next-intl cannot reach', () => {
    for (const [locale, messages] of Object.entries(catalogues)) {
      const dotted = segmentsOf(messages)
        .filter((trail) => trail[trail.length - 1]!.includes('.'))
        .map((trail) => trail.join(' > '));
      expect(dotted, `${locale}.json`).toEqual([]);
    }
  });

  it('have the same keys in both languages', () => {
    expect(keysOf(catalogues.en).sort()).toEqual(keysOf(catalogues.de).sort());
  });

  /*
   * Keys the server sends as strings - an action key, a state reason - are not
   * seen by any type check. Every such literal in the product code has to
   * resolve in both catalogues, or the UI falls back to a generic sentence.
   */
  it('resolve every message key the server hands to the UI', () => {
    const sources = globSync(
      ['packages/core/src/**/*.ts', 'apps/api/src/**/*.ts', 'apps/web/src/**/*.tsx'],
      { cwd: repo, absolute: true, ignore: ['**/*.test.ts', '**/node_modules/**'] },
    );

    const pattern =
      /(?:messageKey|actionKey|labelKey|unavailableKey|detailKey|summaryKey):\s*'([a-z][\w]*(?:\.[\w]+)+)'/g;

    // The absence constructors take their reason as an argument, not a field.
    const constructors =
      /valueEnvelope\.(?:unknown|notTracked|notApplicable)\('([a-z][\w]*(?:\.[\w]+)+)'\)/g;

    // `admin.` and `access.` are message namespaces only - never audit actions -
    // so any literal in them is a key, even inside a ternary or a helper call.
    const namespaced = /'((?:admin|access)\.[a-z][\w.]*)'/g;

    const referenced = new Set<string>();
    for (const file of sources) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(pattern)) referenced.add(match[1]!);
      for (const match of source.matchAll(constructors)) referenced.add(match[1]!);
      for (const match of source.matchAll(namespaced)) referenced.add(match[1]!);
    }

    expect(referenced.size).toBeGreaterThan(20);

    for (const [locale, messages] of Object.entries(catalogues)) {
      // Untyped on purpose: the keys under test are runtime strings, which is
      // exactly why they need a test rather than the compiler.
      const t = createTranslator({ locale, messages, onError: () => undefined }) as unknown as {
        has: (key: string) => boolean;
      };
      // A key may be written with or without the `errors.` namespace; the web
      // app tries both (`resolveError`), so either resolving is enough.
      const unresolved = [...referenced].filter((key) => !t.has(key) && !t.has(`errors.${key}`));
      expect(unresolved, `${locale}.json`).toEqual([]);
    }
  });

  it('name every audit action in the audit trail, in both languages', () => {
    const contract = readFileSync(path.join(repo, 'packages/contracts/src/audit.ts'), 'utf8');
    const actions = [...contract.matchAll(/^ {2}'([a-z_]+(?:\.[a-z_]+)+)',$/gm)].map(
      (match) => match[1]!,
    );
    expect(actions.length).toBeGreaterThan(50);
    for (const [locale, messages] of Object.entries(catalogues)) {
      const t = createTranslator({ locale, messages, onError: () => undefined }) as unknown as {
        has: (key: string) => boolean;
      };
      expect(
        actions.filter((action) => !t.has(`auditAction.${action}`)),
        `${locale}.json`,
      ).toEqual([]);
    }
  });
});
