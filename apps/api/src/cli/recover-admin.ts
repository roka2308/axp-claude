import { parseArgs } from 'node:util';
import { ConfigurationError, getBuildInfo, loadConfig } from '@axp/config';
import { createContainer } from '@axp/core';
import { createLogger } from '@axp/observability';

/**
 * `platform recover-admin` - the audited break-glass path (Gap Review G4).
 *
 * Deliberately distinct from `bootstrap-admin`: it works only on an already
 * initialized platform, mints a token of its own purpose, and every use is
 * recorded under `platform.recovery.*`. It exists so that losing all platform
 * admins does not reopen the setup path.
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
        'Usage: npm run recover-admin -- --requested-by "<name>" [--json]',
        '',
        'Mints a one-time break-glass token that restores platform admin access.',
        'Every issue and use is audited. Only for administrative emergencies.',
      ].join('\n'),
    );
    return;
  }

  const config = loadConfig();
  const logger = createLogger({
    level: 'warn',
    format: config.log.format,
    service: 'recover-admin',
    version: getBuildInfo('api').version,
    appEnv: config.appEnv,
  });

  const container = createContainer({ config, logger });
  try {
    const issued = await container.bootstrap.issueRecoveryToken(values['requested-by']);
    const recoveryUrl = `${config.web.publicUrl}/recover?token=${encodeURIComponent(issued.token)}`;

    if (values.json) {
      console.log(
        JSON.stringify(
          { token: issued.token, expiresAt: issued.expiresAt.toISOString(), recoveryUrl },
          null,
          2,
        ),
      );
      return;
    }

    console.log('');
    console.log('  BREAK-GLASS recovery token created. This action is audited.');
    console.log('');
    console.log(`  Token:       ${issued.token}`);
    console.log(`  Valid until: ${issued.expiresAt.toISOString()}`);
    console.log('');
    console.log('  Open this URL to restore platform admin access:');
    console.log(`  ${recoveryUrl}`);
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
  console.error(`recover-admin failed: ${message}`);
  process.exit(1);
});
