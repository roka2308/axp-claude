'use client';

/**
 * The layout itself failed, so neither translations nor the design system
 * are available. Both languages, plain markup, one way forward.
 */
export default function GlobalError({ reset }: { readonly reset: () => void }) {
  return (
    <html lang="de">
      <body>
        <main id="main-content">
          <h1>Die Seite konnte nicht geladen werden.</h1>
          <p lang="en">The page could not be loaded.</p>
          <p>
            <button type="button" onClick={() => reset()}>
              Erneut versuchen / Try again
            </button>
          </p>
        </main>
      </body>
    </html>
  );
}
