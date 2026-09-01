import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The README makes claims about a file and about what that file prints.
 * Both are checked here, so the quickstart cannot rot into fiction. */
const root = path.join(import.meta.dirname, '..');
const text = (p: string) => readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

test('the README quickstart is examples/loop.ts, verbatim', () => {
  assert.ok(
    text('README.md').includes(text('examples/loop.ts').trim()),
    'the README must show the example it claims to show'
  );
});

test('the decision log in the README is what examples/loop.ts prints', () => {
  const ran = spawnSync(process.execPath, [path.join(root, 'examples', 'loop.ts')], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  const printed = ran.stdout.replace(/\r\n/g, '\n').trim();
  assert.ok(printed.length > 0, 'the example prints its decision log');
  assert.ok(
    text('README.md').includes(printed),
    `the README's decision log is stale; the example printed:\n${printed}`
  );
});

test('the package declares zero runtime dependencies', () => {
  const pkg = JSON.parse(text('package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(pkg.peerDependencies ?? {}), []);
});
