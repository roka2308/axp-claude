import { parseArgs } from 'node:util';
import { ConfigurationError, getBuildInfo, loadConfig } from '@axp/config';
import { createContainer } from '@axp/core';
import { createLogger } from '@axp/observability';
import { seedDemoData } from '../seed-runner';

/**
 * Seeds the canonical demo fixture into a development or test database.
 *
 * Refuses to run against a production environment and with demo fixtures
 * disabled. Passwords are printed here and nowhere else.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      password: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(
      [
        'Usage: npm run seed:demo -- [--password "<shared password>"] [--json]',
        '',
        'Seeds tenant "Corporate Communications Demo", project "Employee Portal"',
        'and the five canonical demo accounts.',
        '',
        'Without --password each account gets its own random password, printed once.',
      ].join('\n'),
    );
    return;
  }

  const config = loadConfig();
  const logger = createLogger({
    level: 'warn',
    format: config.log.format,
    service: 'seed-demo',
    version: getBuildInfo('fixtures').version,
    appEnv: config.appEnv,
  });

  const container = createContainer({ config, logger });
  try {
    const result = await seedDemoData(container, { password: values.password });

    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log('');
    console.log('  Canonical demo fixture applied.');
    console.log(`  Tenant  : Corporate Communications Demo (${result.tenantId})`);
    console.log(`  Project : Employee Portal (${result.projectId})`);
    console.log('');
    console.log('  Accounts:');
    for (const account of result.accounts) {
      console.log(`    ${account.email}`);
      console.log(`      password: ${account.password}`);
      console.log(`      roles   : ${account.roles}`);
    }
    console.log('');
    console.log('  Demo credentials only. Never use these in a production-capable path.');
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
  console.error(`seed:demo failed: ${message}`);
  process.exit(1);
});
