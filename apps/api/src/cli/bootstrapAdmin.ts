import { stdin, stdout } from 'node:process';

import { createDatabase } from '@delivery/database';

import { bootstrapFirstAdmin } from '../application/authService.js';

function getArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value;
}

async function readSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks).toString('utf8').trimEnd();
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk: Buffer): void => {
      const character = chunk.toString('utf8');
      if (character === '\u0003') {
        cleanup();
        reject(new Error('Bootstrap cancelled.'));
      } else if (character === '\r' || character === '\n') {
        cleanup();
        stdout.write('\n');
        resolve(value);
      } else if (character === '\u007f') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stdout.write('\b \b');
        }
      } else {
        value += character;
        stdout.write('*');
      }
    };
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required.');
const database = createDatabase(databaseUrl, 2);
try {
  const result = await bootstrapFirstAdmin({
    database,
    email: getArgument('--email'),
    organizationName: getArgument('--organization'),
    password: await readSecret('Initial admin password: '),
  });
  stdout.write(
    `Bootstrap complete. User ${result.userId}, organization ${result.organizationId}.\n`,
  );
} finally {
  await database.destroy();
}
