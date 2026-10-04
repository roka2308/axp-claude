'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { DiagnosticArtifactSummary } from '@axp/contracts';
import { Button, Callout, TextField } from '@axp/ui';
import { reauthenticateAction } from '@/app/admin/actions';
import { generateDiagnosticsAction } from '@/app/admin/productization-actions';

/**
 * Generates a diagnostic bundle (Master Spec §24).
 *
 * A privileged action: the password is confirmed first when the last sign-in
 * is not recent. The bundle is offered for download until it expires.
 */
export function DiagnosticsPanel() {
  const t = useTranslations('system.diagnostics');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<DiagnosticArtifactSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = () =>
    startTransition(async () => {
      setError(null);
      if (needsPassword) {
        const reauth = await reauthenticateAction(password);
        setPassword('');
        if (reauth.status !== 'ok') {
          setError(reauth.status === 'error' ? reauth.message : t('reauthFailed'));
          return;
        }
      }
      const outcome = await generateDiagnosticsAction();
      if (outcome.status === 'reauth') setNeedsPassword(true);
      else if (outcome.status === 'error') setError(outcome.message);
      else if (outcome.data) {
        setNeedsPassword(false);
        setResult(outcome.data);
        router.refresh();
      }
    });

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        generate();
      }}
    >
      <p>{t('explain')}</p>
      {needsPassword ? (
        <div className="stack stack--tight">
          <p>{t('reauthExplain')}</p>
          <TextField
            label={t('password')}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
      ) : null}
      <div>
        <Button type="submit" variant="primary" disabled={pending || (needsPassword && !password)}>
          {pending ? t('generating') : t('generate')}
        </Button>
      </div>
      {error ? (
        <Callout tone="critical" live>
          {error}
        </Callout>
      ) : null}
      {result ? (
        <Callout tone="success" title={t('readyTitle')} live>
          <a href={`/admin/system/bundles/${result.id}`} download={result.fileName}>
            {t('download', { file: result.fileName })}
          </a>{' '}
          {t('validUntil', {
            time: new Date(result.expiresAt).toLocaleTimeString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
            }),
          })}
        </Callout>
      ) : null}
    </form>
  );
}
