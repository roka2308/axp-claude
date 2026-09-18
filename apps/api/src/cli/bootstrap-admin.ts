import { parseArgs } from 'node:util';
import { ConfigurationError, getBuildInfo, loadConfig } from '@axp/config';
import { createContainer } from '@axp/core';
import { createLogger } from '@axp/observability';

/**
 * `platform bootstrap-admin` (Master Spec §6, Gap Review G4).
 *
 * A privileged, deployment-neutral local process. It does NOT create an
 * account: it mints one short-lived, single-use activation token and prints the
 * setup URL. The operator then chooses the address and password in the browser,
 * which is why this product ships no default credentials at all.
 *
 * The token is written to stdout only. It is never logged, never stored in
 * plaintext and never sent anywhere.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'requested-by': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(
      [
        'Usage: npm run bootstrap-admin -- [--requested-by "<name>"] [--json]',
        '',
        'Mints a one-time activation token for creating the first platform admin.',
        'Refused once the platform is initialized; use recover-admin instead.',
      ].join('\n'),
    );
    return;
  }

  const config = loadConfig();
  const logger = createLogger({
    // The token must not end up in a log line; keep this process quiet.
    level: 'warn',
    format: config.log.format,
    service: 'bootstrap-admin',
    version: getBuildInfo('api').version,
    appEnv: config.appEnv,
  });

  const container = createContainer({ config, logger });
  try {
    const issued = await container.bootstrap.issueInitialBootstrapToken(values['requested-by']);
    const setupUrl = `${config.web.publicUrl}/setup?token=${encodeURIComponent(issued.token)}`;

    if (values.json) {
      console.log(
        JSON.stringify(
          { token: issued.token, expiresAt: issued.expiresAt.toISOString(), setupUrl },
          null,
          2,
        ),
      );
      return;
    }

    console.log('');
    console.log('  Platform bootstrap token created.');
    console.log('');
    console.log(`  Token:      ${issued.token}`);
    console.log(`  Valid until: ${issued.expiresAt.toISOString()}`);
    console.log('');
    console.log('  Open this URL to create the first platform admin:');
    console.log(`  ${setupUrl}`);
    console.log('');
    console.log('  The token is single-use and is shown here only once.');
    console.log('');
  } finally {
    await container.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    console.error(error.message);
    process.exit(78);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`bootstrap-admin failed: ${message}`);
  process.exit(1);
});
