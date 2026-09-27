import { redirect } from 'next/navigation';
import { getAdminContext } from '@/lib/admin';

/**
 * Administration entry. Goes where there is something to do: a tenant's users
 * for a tenant administrator, the tenant list for a platform administrator
 * without a tenant of their own.
 */
export default async function AdminPage() {
  const context = await getAdminContext().catch(() => null);
  if (context?.platformAdmin && context.tenants.length === 0) redirect('/admin/tenants');
  redirect('/admin/users');
}
