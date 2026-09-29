import { ApiError, apiDownload } from '@/lib/api-client';
import { shareHeaders } from '@/lib/sharing';

/**
 * A share recipient's export download. The link token (and the password
 * session, when there is one) goes to the API as headers; the API checks the
 * share is still valid, allows exports, and made this file.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; artifactId: string }> },
): Promise<Response> {
  const { token, artifactId } = await params;
  try {
    const file = await apiDownload(`/public/share/exports/${encodeURIComponent(artifactId)}`, {
      headers: await shareHeaders(token),
      timeoutMs: 60_000,
    });
    return new Response(file.body, {
      status: 200,
      headers: {
        'content-type': file.contentType,
        'content-disposition': file.disposition,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      },
    });
  } catch (error) {
    return new Response(null, { status: error instanceof ApiError ? error.status : 502 });
  }
}
