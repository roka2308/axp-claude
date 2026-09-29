import { ApiError, apiDownload } from '@/lib/api-client';

/**
 * Hands a finished export to the browser (Master Spec §15).
 *
 * The file comes from the API with the caller's session; the API refuses
 * anyone but the requester and anything expired. Nothing is cached on the way.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ artifactId: string }> },
): Promise<Response> {
  const { artifactId } = await params;
  try {
    const file = await apiDownload(`/exports/${encodeURIComponent(artifactId)}`, {
      authenticated: true,
      timeoutMs: 60_000,
    });
    return fileResponse(file);
  } catch (error) {
    return new Response(null, { status: error instanceof ApiError ? error.status : 502 });
  }
}

function fileResponse(file: {
  body: ArrayBuffer;
  contentType: string;
  disposition: string;
}): Response {
  return new Response(file.body, {
    status: 200,
    headers: {
      'content-type': file.contentType,
      'content-disposition': file.disposition,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
