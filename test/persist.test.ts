import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitLesson, createForge, promote, propose, screen, trial } from '../src/forge.ts';
import { ForgeError } from '../src/forge.ts';
import { hydrateForge, serializeForge } from '../src/persist.ts';
import type { Artifact, ForgeState, Lesson, Run } from '../src/forge.ts';
import type { PredicateRegistry } from '../src/persist.ts';

const BEHAVIOURS: Record<string, Record<string, string>> = {
  'model-v1': { 'sum 2 and 2': '5', 'is it raining': 'yes' },
  'model-v2': { 'sum 2 and 2': '4', 'is it raining': 'no' },
  'model-v3-regressive': { 'sum 2 and 2': '5', 'is it raining': 'no' }
};

const run: Run = (artifact, input) => {
  const out = BEHAVIOURS[artifact.ref]?.[input];
  if (out === undefined) throw new Error(`no behaviour for "${input}"`);
  return out;
};

const art = (id: string, ref = id): Artifact => ({ id, ref });

/** The registry is the durable half of a lesson: the predicate lives in
 * code under a key, the snapshot carries the key. */
const PREDICATES: PredicateRegistry = {
  'equals-4': (o) => o === '4',
  'equals-no': (o) => o === 'no'
};

const sumLesson: Lesson = {
  id: 'lesson-sum',
  input: 'sum 2 and 2',
  holds: PREDICATES['equals-4'],
  predicate: 'equals-4',
  note: 'basic arithmetic must not regress',
  review: { reviewedBy: 'miguel' }
};

const dryLesson: Lesson = {
  id: 'lesson-dry',
  input: 'is it raining',
  holds: PREDICATES['equals-no'],
  predicate: 'equals-no',
  note: 'model-v1 claims rain out of a clear sky',
  review: { reviewedBy: 'miguel' }
};

/** A forge with two lessons, one promotion and one candidate on record. */
async function usedForge(): Promise<ForgeState> {
  let { state } = await admitLesson(createForge(art('model-v1')), sumLesson, run);
  ({ state } = await admitLesson(state, dryLesson, run));
  ({ state } = propose(state, art('model-v2')));
  ({ state } = await screen(state, 'model-v2', run));
  ({ state } = trial(state, 'model-v2', { improved: true, detail: 'exact 0.91 vs 0.74' }));
  ({ state } = promote(state, 'model-v2'));
  return state;
}

test('a forge survives a process boundary: JSON out, forge back in', async () => {
  const before = await usedForge();
  const snapshot = serializeForge(before);

  // the snapshot is plain JSON: no functions survive the trip
  const wire = JSON.parse(JSON.stringify(snapshot));
  assert.deepEqual(wire, snapshot);
  assert.deepEqual(wire.lessons.map((l: { predicate: string }) => l.predicate), ['equals-4', 'equals-no']);

  const after = hydrateForge(wire, PREDICATES);
  assert.deepEqual(after.incumbent, before.incumbent);
  assert.deepEqual(after.archive, before.archive);
  assert.deepEqual(after.decisions, before.decisions);
  assert.deepEqual(after.candidates, before.candidates);
  assert.deepEqual(after.lessons.map((l) => l.id), ['lesson-sum', 'lesson-dry']);

  // the gate still bites, on the far side of the restart
  let state = after;
  ({ state } = propose(state, art('model-v3-regressive')));
  const step = await screen(state, 'model-v3-regressive', run);
  assert.equal(step.decision.outcome, 'refused');
  assert.match(step.decision.reason, /lesson-sum/);
});

test('hydrating without a recorded predicate fails loudly, naming the key', async () => {
  const snapshot = serializeForge(await usedForge());
  assert.throws(
    () => hydrateForge(snapshot, { 'equals-4': PREDICATES['equals-4'] }),
    (err: unknown) => {
      assert.ok(err instanceof ForgeError);
      assert.match(err.message, /lesson-dry/);
      assert.match(err.message, /equals-no/);
      return true;
    },
    'a missing predicate must never silently weaken the gate'
  );
});

test('a lesson with no predicate key cannot be serialized', async () => {
  const anonymous: Lesson = {
    id: 'lesson-anon',
    input: 'sum 2 and 2',
    holds: (o) => o === '4',
    note: 'x',
    review: { reviewedBy: 'miguel' }
  };
  const { state } = await admitLesson(createForge(art('model-v1')), anonymous, run);
  assert.throws(
    () => serializeForge(state),
    (err: unknown) => {
      assert.ok(err instanceof ForgeError);
      assert.match(err.message, /lesson-anon/);
      return true;
    }
  );
});

test('a snapshot from an unknown format version is refused', async () => {
  const snapshot = serializeForge(await usedForge());
  assert.throws(
    () => hydrateForge({ ...snapshot, version: 99 as unknown as 1 }, PREDICATES),
    (err: unknown) => err instanceof ForgeError && /99/.test(err.message)
  );
});
