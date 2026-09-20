import type { ConnectionTestResult } from '@axp/contracts';

/**
 * Shared state shape for the setup forms.
 *
 * Its own module because a `'use server'` file may export nothing but async
 * functions: a constant there is a build error, not a style question.
 */
export interface SetupFormState {
  readonly status: 'idle' | 'error' | 'tested' | 'saved';
  readonly message?: string;
  readonly action?: string;
  readonly correlationId?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /**
   * Preserved so a failed attempt does not clear what was typed.
   *
   * Never carries a credential: everything here is serialised into the page,
   * and a token echoed back into a form value would be a token in the browser.
   */
  readonly values?: Readonly<Record<string, string>>;
  /** Present after a connection test, so the result can be shown in place. */
  readonly test?: ConnectionTestResult;
}

export const INITIAL_SETUP_STATE: SetupFormState = { status: 'idle' };
