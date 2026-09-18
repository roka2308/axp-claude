import type { ReactNode } from 'react';
import styles from './Card.module.css';

export interface CardProps {
  readonly title?: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly padded?: boolean;
  readonly children?: ReactNode;
  /** Renders the card as a section with an accessible name. */
  readonly as?: 'div' | 'section' | 'article';
}

export function Card({
  title,
  description,
  actions,
  padded = true,
  children,
  as: Element = 'section',
}: CardProps) {
  return (
    <Element
      className={[styles.card, padded ? styles.padded : ''].filter(Boolean).join(' ')}
      aria-label={title}
    >
      {title || actions ? (
        <header className={styles.header}>
          <div>
            {title ? <h2 className={styles.title}>{title}</h2> : null}
            {description ? <p className={styles.description}>{description}</p> : null}
          </div>
          {actions}
        </header>
      ) : null}
      {children}
    </Element>
  );
}
