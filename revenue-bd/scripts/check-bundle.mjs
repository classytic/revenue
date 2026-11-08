import { build } from 'tsdown';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const temporary = await mkdtemp(join(tmpdir(), 'revenue-bd-consumer-'));
try {
  const fixture = join(temporary, 'consumer.mjs');
  await writeFile(fixture, `export { BkashProvider } from ${JSON.stringify(resolve('dist/bkash/index.mjs'))};`);
  await build({
    config: false, entry: [fixture], outDir: join(temporary, 'dist'), format: 'esm',
    dts: false, logLevel: 'silent', deps: { neverBundle: [/^@classytic\//, /^node:/] },
  });
  const files = await readdir(join(temporary, 'dist'));
  const output = (await Promise.all(files.filter(name => /\.m?js$/.test(name)).map(name => readFile(join(temporary, 'dist', name), 'utf8')))).join('\n');
  assert(output.includes('BkashProvider'), 'Consumer must retain the selected provider.');
  assert(output.includes('supportsConfirmation'), 'The provider implementation must actually be bundled, not left as an unresolved import.');
  assert(!output.includes('file://'), 'Consumer must not retain an unresolved file-URL import.');
  assert(!/createBkashTokenSource|class TokenSource/.test(output), 'Unused token-source factory must be removed.');
  assert(!/@classytic\/(?:revenue|arc|mongokit)|mongoose|stripe|nagad/i.test(output), 'Consumer must not load an engine, framework or another provider.');
  console.log('Provider consumer bundle excludes unused token factory, engines and other providers.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
