import { ApiError, apiDownload } from '@/lib/api-client';

/** Hands a diagnostic bundle to its creator; the API refuses everyone else. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bundleId: string }> },
): Promise<Response> {
  const { bundleId } = await params;
  try {
    const file = await apiDownload(`/admin/platform/diagnostics/${encodeURIComponent(bundleId)}`, {
      authenticated: true,
    });
    return new Response(file.body, {
      status: 200,
      headers: {
        'content-type': file.contentType,
        'content-disposition': file.disposition,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    return new Response(null, { status: error instanceof ApiError ? error.status : 502 });
  }
}
