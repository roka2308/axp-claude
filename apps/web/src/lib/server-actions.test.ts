import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { globSync } from 'tinyglobby';

/**
 * A `'use server'` module may export nothing but async functions.
 *
 * Next enforces this at runtime, not at build time: a constant exported from
 * an action file builds cleanly and then breaks the page the first time
 * somebody opens it. That happened twice while building this product, so it
 * gets a test rather than a third recurrence.
 */
describe('server action modules', () => {
  const root = path.resolve(__dirname, '../..');
  const files = globSync('src/**/*.ts', { cwd: root, absolute: true });

  const actionFiles = files.filter((file) => {
    const source = readFileSync(file, 'utf8');
    return /^\s*['"]use server['"]/m.test(source);
  });

  it('finds the action modules to check', () => {
    expect(actionFiles.length).toBeGreaterThan(0);
  });

  it.each(actionFiles)('%s exports only async functions', (file) => {
    const source = readFileSync(file, 'utf8');

    const exports = [...source.matchAll(/^export\s+(?!type\b|interface\b)(\w+)/gm)].map(
      (match) => match[1]!,
    );

    for (const keyword of exports) {
      // `export async function` is the only runtime export Next accepts here.
      // Types and interfaces are erased and therefore fine.
      expect(keyword, `${path.basename(file)} exports a "${keyword}"`).toBe('async');
    }
  });
});
