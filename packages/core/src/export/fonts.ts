import { createRequire } from 'node:module';

/**
 * The typeface export files are set in.
 *
 * DejaVu Sans, from its npm package, rather than whatever the host happens to
 * have installed: a container without fonts must produce the same PDF as a
 * workstation, with every umlaut and dash, and the chart images need a font
 * the rasteriser can load by path.
 */
const require = createRequire(import.meta.url);

let resolved: { regular: string; bold: string } | undefined;

export function exportFonts(): { regular: string; bold: string } {
  resolved ??= {
    regular: require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'),
    bold: require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf'),
  };
  return resolved;
}
