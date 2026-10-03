'use server';

import { revalidatePath } from 'next/cache';
import { apiRequest } from '@/lib/api-client';
import { resolveError } from '@/lib/error-messages';
import type { AdminOutcome as Outcome } from '@/app/admin/outcome';

/** "Seen it." The item stays until the problem is gone; it just stops being new. */
export async function acknowledgeAttentionAction(itemId: string): Promise<Outcome> {
  try {
    await apiRequest(`/attention/${encodeURIComponent(itemId)}/acknowledge`, {
      method: 'POST',
      body: {},
      authenticated: true,
    });
    revalidatePath('/attention');
    return { status: 'ok' };
  } catch (error) {
    return { status: 'error', message: (await resolveError(error)).message };
  }
}
