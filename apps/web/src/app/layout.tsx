import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import './globals.css';

export const metadata: Metadata = {
  title: 'Analytics Experience',
  description: 'Semantic analytics, dashboard and reporting platform on top of Matomo.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Never cap zoom: users must be able to enlarge text (D10 zoom/reflow).
  maximumScale: 5,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  const t = await getTranslations('nav');

  return (
    <html lang={locale}>
      <body>
        {/*
          Keyboard users reach the content without traversing the whole shell.
          The link is visually hidden until focused (D10: keyboard operable).
        */}
        <a className="skip-link" href="#main-content">
          {t('skipToContent')}
        </a>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
