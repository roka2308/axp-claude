/**
 * What an administration action returns (D5).
 *
 * Its own module because a `'use server'` file may export nothing but async
 * functions. Three outcomes, kept apart on purpose: done, refused with a
 * reason, and "confirm your password first" - the last is not a failure, and
 * the UI answers it by asking rather than by showing an error.
 */
export type AdminOutcome<T = void> =
  | { readonly status: 'ok'; readonly data?: T }
  | {
      readonly status: 'error';
      readonly message: string;
      readonly fieldErrors?: Readonly<Record<string, string>>;
    }
  | { readonly status: 'reauth' };
