'use client';

import { useState } from 'react';
import { Button } from '@axp/ui';

export interface CopyLinkButtonProps {
  readonly label: string;
  readonly copiedLabel: string;
}

/**
 * Copies the current URL, which is what makes a detail view shareable.
 *
 * The detail view lives in the address bar - `?widget=<id>` on the dashboard -
 * so there is nothing to construct here. Anyone without a clipboard API still
 * has the address bar, which is why this is a convenience rather than the only
 * way to share a view.
 */
export function CopyLinkButton({ label, copiedLabel }: CopyLinkButtonProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // No clipboard permission. The URL is in the address bar either way.
      setCopied(false);
    }
  }

  return (
    <Button type="button" onClick={copy} aria-live="polite">
      {copied ? copiedLabel : label}
    </Button>
  );
}
