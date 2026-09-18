import type { ReactNode } from 'react';

/**
 * Content available to assistive technology but not painted.
 *
 * Used for chart data alternatives, state announcements and any label whose
 * visual counterpart is an icon or a colour.
 */
export function VisuallyHidden({ children }: { readonly children: ReactNode }) {
  return <span className="axp-visually-hidden">{children}</span>;
}
