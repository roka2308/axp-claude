'use client';

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { useTranslations } from 'next-intl';
import styles from './DetailOverlay.module.css';

export interface DetailOverlayProps {
  /**
   * Where closing leads: the dashboard without the widget parameter.
   *
   * Typed as a route because it is one; it is assembled at runtime from the
   * current query, which is more than the literal-template check can follow.
   */
  readonly closeHref: Route;
  readonly title: string;
  readonly children: ReactNode;
}

/**
 * The focus-managed dialog around a Widget Detail View (D4, D10).
 *
 * The content is rendered on the server and already in the document, so the
 * detail view is readable and linkable with no JavaScript at all. This
 * component adds what a dialog owes a keyboard user: focus moves in, stays in
 * while it is open, and returns to where it came from on close. Escape closes
 * it, and so does clicking the backdrop.
 *
 * A large panel on desktop, the whole viewport on a phone - the same markup
 * either way, because "fully usable on mobile" is a layout question, not a
 * different component (Gate F4).
 */
export function DetailOverlay({ closeHref, title, children }: DetailOverlayProps) {
  const router = useRouter();
  const t = useTranslations('detail');
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    router.push(closeHref, { scroll: false });
  }, [router, closeHref]);

  useEffect(() => {
    // Where focus was before the dialog opened, so it can be put back.
    const opener = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }

      if (event.key !== 'Tab') return;

      // Focus stays inside: Tab past the last control wraps to the first, and
      // Shift+Tab before the first wraps to the last.
      const focusable = panel.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);

    // The page behind must not scroll under the panel.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
  }, [close]);

  return (
    <div className={styles.backdrop} onClick={close}>
      <div
        ref={panel}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // The backdrop closes; a click inside must not.
        onClick={(event) => event.stopPropagation()}
      >
        <button ref={closeButton} type="button" className={styles.close} onClick={close}>
          {t('close')}
        </button>
        {children}
      </div>
    </div>
  );
}
