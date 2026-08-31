import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  admitLesson,
  createForge,
  promote,
  propose,
  rollback,
  screen,
  trial
} from '../src/forge.ts';
import type { Artifact, Lesson, Run } from '../src/forge.ts';

/** Artifacts are behaviour tables: input -> output. The executor reads
 * them; the forge never does. */
const BEHAVIOURS: Record<string, Record<string, string>> = {
  'model-v1': { 'sum 2 and 2': '5', 'name the account': 'acct-77', 'is it raining': 'yes' },
  'model-v2': { 'sum 2 and 2': '4', 'name the account': 'acct-77', 'is it raining': 'no' },
  'model-v2-regressive': { 'sum 2 and 2': '5', 'name the account': 'acct-77', 'is it raining': 'no' }
};

const run: Run = (artifact, input) => {
  const table = BEHAVIOURS[artifact.ref];
  const out = table?.[input];
  if (out === undefined) throw new Error(`no behaviour for "${input}"`);
  return out;
};

const art = (id: string, ref = id): Artifact => ({ id, ref });

const sumLesson: Lesson = {
  id: 'lesson-sum',
  input: 'sum 2 and 2',
  holds: (o) => o === '4',
  note: 'basic arithmetic must not regress',
  review: { reviewedBy: 'miguel' }
};

async function forgeWithLesson() {
  let { state } = await admitLesson(createForge(art('model-v1')), sumLesson, run);
  return state;
}

test('a lesson that does not reproduce on the incumbent is refused', async () => {
  const state = createForge(art('model-v2'));
  const step = await admitLesson(state, sumLesson, run);
  assert.equal(step.decision.outcome, 'refused');
  assert.match(step.decision.reason, /does not reproduce teaches nothing/);
  assert.equal(step.state.lessons.length, 0);
});

test('a lesson nobody signed is refused: well-formed is not approved', async () => {
  const unsigned = { ...sumLesson, id: 'lesson-x', review: { reviewedBy: '' } };
  const step = await admitLesson(createForge(art('model-v1')), unsigned, run);
  assert.equal(step.decision.outcome, 'refused');
  assert.match(step.decision.reason, /not approved/);
});

test('a reproduced, signed lesson is admitted with both facts on record', async () => {
  const step = await admitLesson(createForge(art('model-v1')), sumLesson, run);
  assert.equal(step.decision.outcome, 'accepted');
  assert.match(step.decision.reason, /reproduced on model-v1, signed by miguel/);
});

test('the full loop: propose, screen, trial, promote; the incumbent is archived', async () => {
  let state = await forgeWithLesson();
  ({ state } = propose(state, art('model-v2')));
  ({ state } = await screen(state, 'model-v2', run));
  assert.equal(state.candidates['model-v2'].status, 'screened');
  ({ state } = trial(state, 'model-v2', { improved: true, detail: 'exact 0.91 vs 0.74' }));
  const step = promote(state, 'model-v2');
  assert.equal(step.decision.outcome, 'accepted');
  assert.equal(step.state.incumbent.id, 'model-v2');
  assert.deepEqual(step.state.archive.map((a) => a.id), ['model-v1']);
});

test('a candidate that breaks an old lesson is rejected with the lesson named', async () => {
  let state = await forgeWithLesson();
  ({ state } = propose(state, art('model-v2-regressive')));
  const step = await screen(state, 'model-v2-regressive', run);
  assert.equal(step.decision.outcome, 'refused');
  assert.match(step.decision.reason, /lesson-sum/);
  assert.equal(step.state.candidates['model-v2-regressive'].status, 'rejected');
});

test('an erroring probe is unknown: not a rejection, but promotion refuses', async () => {
  let state = await forgeWithLesson();
  const ghost: Lesson = {
    id: 'lesson-ghost',
    input: 'a probe nobody implemented',
    holds: () => true,
    note: 'x',
    review: { reviewedBy: 'miguel' }
  };
  // Force-admit by probing an input the incumbent errors on: admission
  // itself refuses, which is the point - so admit against a stub instead.
  const admitted = await admitLesson(
    { ...state, incumbent: art('model-v1') },
    { ...ghost, input: 'is it raining', holds: (o) => o === 'no' },
    run
  );
  state = admitted.state;
  ({ state } = propose(state, art('model-broken', 'no-such-table')));
  const step = await screen(state, 'model-broken', run);
  assert.equal(step.decision.outcome, 'accepted');
  assert.match(step.decision.reason, /unknown/);
  const c = step.state.candidates['model-broken'];
  assert.equal(c.status, 'screened');
  assert.ok(c.immunity.every((r) => r.outcome === 'unknown'));

  let s2 = step.state;
  ({ state: s2 } = trial(s2, 'model-broken', { improved: true, detail: 'somehow' }));
  const promoted = promote(s2, 'model-broken');
  assert.equal(promoted.decision.outcome, 'refused');
  assert.match(promoted.decision.reason, /neither a pass nor a fail/);
});

test('losing the trial rejects, with the margin on record', async () => {
  let state = await forgeWithLesson();
  ({ state } = propose(state, art('model-v2')));
  ({ state } = await screen(state, 'model-v2', run));
  const step = trial(state, 'model-v2', { improved: false, detail: 'exact 0.70 vs 0.74' });
  assert.equal(step.decision.outcome, 'refused');
  assert.equal(step.state.candidates['model-v2'].status, 'rejected');
  assert.match(step.state.candidates['model-v2'].rejectionReason!, /0\.70 vs 0\.74/);
});

test('an unscreened candidate cannot stand trial or be promoted', async () => {
  let state = await forgeWithLesson();
  ({ state } = propose(state, art('model-v2')));
  assert.equal(trial(state, 'model-v2', { improved: true, detail: 'x' }).decision.outcome, 'refused');
  assert.equal(promote(state, 'model-v2').decision.outcome, 'refused');
});

test('rollback restores the archived incumbent, and needs a reason', async () => {
  let state = await forgeWithLesson();
  ({ state } = propose(state, art('model-v2')));
  ({ state } = await screen(state, 'model-v2', run));
  ({ state } = trial(state, 'model-v2', { improved: true, detail: 'y' }));
  ({ state } = promote(state, 'model-v2'));

  assert.equal(rollback(state, '   ').decision.outcome, 'refused');
  const step = rollback(state, 'v2 misbehaves on live traffic');
  assert.equal(step.state.incumbent.id, 'model-v1');
  assert.match(step.decision.reason, /live traffic/);
  assert.equal(step.state.lessons.length, state.lessons.length, 'rollback deletes nothing');
});

test('the suite only grows: no removal API, and new lessons bind future candidates', async () => {
  let state = await forgeWithLesson();
  ({ state } = propose(state, art('model-v2')));
  ({ state } = await screen(state, 'model-v2', run));
  ({ state } = trial(state, 'model-v2', { improved: true, detail: 'z' }));
  ({ state } = promote(state, 'model-v2'));

  // v2 is incumbent; a new mistake is found and reproduces on it.
  const rainLesson: Lesson = {
    id: 'lesson-rain',
    input: 'is it raining',
    holds: (o) => o === 'yes',
    note: 'v2 answers no when the truth is yes',
    review: { reviewedBy: 'miguel' }
  };
  const admitted = await admitLesson(state, rainLesson, run);
  assert.equal(admitted.decision.outcome, 'accepted');
  state = admitted.state;
  assert.equal(state.lessons.length, 2);

  // A future candidate must now hold BOTH lessons; v1's old bug included.
  ({ state } = propose(state, art('model-v1-again', 'model-v1')));
  const step = await screen(state, 'model-v1-again', run);
  assert.equal(step.decision.outcome, 'refused');
  assert.match(step.decision.reason, /lesson-sum/);
});

test('every decision lands in the log, in order, with a reason', async () => {
  let state = await forgeWithLesson();
  ({ state } = propose(state, art('model-v2')));
  ({ state } = await screen(state, 'model-v2', run));
  assert.deepEqual(state.decisions.map((d) => d.action), ['admit-lesson', 'propose', 'screen']);
  assert.deepEqual(state.decisions.map((d) => d.seq), [0, 1, 2]);
  assert.ok(state.decisions.every((d) => d.reason.length > 0));
});

test('a throwing holds predicate refuses admission instead of escaping', async () => {
  const bomb: Lesson = {
    id: 'lesson-bomb',
    input: 'sum 2 and 2',
    holds: () => {
      throw new Error('predicate exploded');
    },
    note: 'x',
    review: { reviewedBy: 'miguel' }
  };
  const step = await admitLesson(createForge(art('model-v1')), bomb, run);
  assert.equal(step.decision.outcome, 'refused');
  assert.match(step.decision.reason, /could not be evaluated.*exploded/);
});

test('screening runs once: unknown cannot be cleared by re-rolling a flaky probe', async () => {
  let state = await forgeWithLesson();
  ({ state } = propose(state, art('model-broken', 'no-such-table')));
  ({ state } = await screen(state, 'model-broken', run));
  assert.ok(state.candidates['model-broken'].immunity.some((r) => r.outcome === 'unknown'));
  const again = await screen(state, 'model-broken', run);
  assert.equal(again.decision.outcome, 'refused');
  assert.match(again.decision.reason, /unknown stays sticky/);
});

test('rollback demotes the rolled-back candidate in the record', async () => {
  let state = await forgeWithLesson();
  ({ state } = propose(state, art('model-v2')));
  ({ state } = await screen(state, 'model-v2', run));
  ({ state } = trial(state, 'model-v2', { improved: true, detail: 'y' }));
  ({ state } = promote(state, 'model-v2'));
  ({ state } = rollback(state, 'live regression'));
  assert.equal(state.incumbent.id, 'model-v1');
  assert.equal(state.candidates['model-v2'].status, 'rolled-back');
});
