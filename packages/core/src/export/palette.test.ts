import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPORT_PALETTE, EXPORT_PALETTE_TOKENS } from './palette';

const TOKENS_CSS = fileURLToPath(new URL('../../../ui/src/tokens/tokens.css', import.meta.url));

function tokenValue(css: string, name: string): string | undefined {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
  return match?.[1]?.toLowerCase();
}

describe('export palette', () => {
  const css = readFileSync(TOKENS_CSS, 'utf8');

  it('uses the default theme token values, not colours of its own', () => {
    for (const [key, token] of Object.entries(EXPORT_PALETTE_TOKENS)) {
      expect(EXPORT_PALETTE[key as keyof typeof EXPORT_PALETTE], token).toBe(
        tokenValue(css, token),
      );
    }
  });

  it('draws evaluation bands in the theme band colours', () => {
    EXPORT_PALETTE.evaluationBand.forEach((colour, index) => {
      expect(colour).toBe(tokenValue(css, `--evaluation-band-${index + 1}`));
    });
  });
});
