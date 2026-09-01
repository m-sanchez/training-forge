import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  admitLesson,
  createForge,
  promote,
  propose,
  rescreen,
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
  'model-v2-regressive': { 'sum 2 and 2': '5', 'name the account': 'acct-77', 'is it raining': 'no' },
  // answers the weather, errors on arithmetic: one probe is unknowable
  'model-partial': { 'is it raining': 'no' },
  // holds the arithmetic lesson, breaks a lesson admitted later
  'model-v2-drifted': { 'sum 2 and 2': '4', 'name the account': 'acct-77', 'is it raining': 'yes' }
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

test('an unknown candidate id is a logged refusal, not a thrown error', async () => {
  const state = await forgeWithLesson();

  const screened = await screen(state, 'model-typo', run);
  assert.equal(screened.decision.outcome, 'refused');
  assert.match(screened.decision.reason, /no candidate "model-typo"/);
  assert.equal(screened.decision.action, 'screen');
  assert.equal(screened.state.decisions.length, state.decisions.length + 1);

  const tried = trial(state, 'model-typo', { improved: true, detail: 'x' });
  assert.equal(tried.decision.outcome, 'refused');
  assert.match(tried.decision.reason, /no candidate "model-typo"/);

  const promoted = promote(state, 'model-typo');
  assert.equal(promoted.decision.outcome, 'refused');
  assert.match(promoted.decision.reason, /no candidate "model-typo"/);
});

/** Admitted against incumbent model-v1, which says "yes" to a dry sky. */
const dryLesson: Lesson = {
  id: 'lesson-dry',
  input: 'is it raining',
  holds: (o) => o === 'no',
  note: 'model-v1 claims rain out of a clear sky',
  review: { reviewedBy: 'miguel' }
};

test('promotion refuses a candidate the immunity gate has not covered', async () => {
  // Monday: v2 is screened against every lesson admitted so far.
  let state = await forgeWithLesson();
  ({ state } = propose(state, art('model-v2')));
  ({ state } = await screen(state, 'model-v2', run));
  ({ state } = trial(state, 'model-v2', { improved: true, detail: 'exact 0.91 vs 0.74' }));

  // Tuesday: a new mistake is found on the incumbent and admitted.
  const admitted = await admitLesson(state, dryLesson, run);
  assert.equal(admitted.decision.outcome, 'accepted');
  state = admitted.state;

  // Wednesday: v2 has never been evaluated against lesson-dry.
  const step = promote(state, 'model-v2');
  assert.equal(step.decision.outcome, 'refused');
  assert.match(step.decision.reason, /lesson-dry/);
  assert.equal(step.state.incumbent.id, 'model-v1');
});

test('a re-screen covers the lessons admitted since screening; promotion then earns it', async () => {
  let state = await forgeWithLesson();
  ({ state } = propose(state, art('model-v2')));
  ({ state } = await screen(state, 'model-v2', run));
  ({ state } = trial(state, 'model-v2', { improved: true, detail: 'exact 0.91 vs 0.74' }));
  ({ state } = await admitLesson(state, dryLesson, run));
  assert.equal(promote(state, 'model-v2').decision.outcome, 'refused');

  const rescreened = await rescreen(state, 'model-v2', run);
  assert.equal(rescreened.decision.outcome, 'accepted');
  assert.match(rescreened.decision.reason, /lesson-dry/);
  state = rescreened.state;
  assert.deepEqual(
    state.candidates['model-v2'].immunity,
    [
      { lessonId: 'lesson-sum', outcome: 'held' },
      { lessonId: 'lesson-dry', outcome: 'held' }
    ]
  );
  assert.equal(state.candidates['model-v2'].status, 'trialed', 're-screening does not undo the trial');

  const step = promote(state, 'model-v2');
  assert.equal(step.decision.outcome, 'accepted');
  assert.equal(step.state.incumbent.id, 'model-v2');
});

test('a re-screen adds results; it never re-runs a lesson, so unknown stays sticky', async () => {
  let state = await forgeWithLesson();
  ({ state } = propose(state, art('model-partial')));
  ({ state } = await screen(state, 'model-partial', run));
  assert.deepEqual(
    state.candidates['model-partial'].immunity.map((r) => r.outcome),
    ['unknown']
  );

  ({ state } = await admitLesson(state, dryLesson, run));
  const rescreened = await rescreen(state, 'model-partial', run);
  assert.equal(rescreened.decision.outcome, 'accepted');
  state = rescreened.state;
  const immunity = state.candidates['model-partial'].immunity;
  assert.equal(immunity.length, 2, 'one result per lesson, never a second');
  assert.equal(immunity.find((r) => r.lessonId === 'lesson-sum')!.outcome, 'unknown');
  assert.equal(immunity.find((r) => r.lessonId === 'lesson-dry')!.outcome, 'held');

  // nothing outstanding: the sticky unknown cannot be re-rolled
  const again = await rescreen(state, 'model-partial', run);
  assert.equal(again.decision.outcome, 'refused');
  assert.match(again.decision.reason, /unknown stays sticky/);

  ({ state } = trial(state, 'model-partial', { improved: true, detail: 'somehow' }));
  const promoted = promote(state, 'model-partial');
  assert.equal(promoted.decision.outcome, 'refused');
  assert.match(promoted.decision.reason, /neither a pass nor a fail/);
});

test('a re-screen that finds a broken lesson rejects the candidate, lesson named', async () => {
  let state = await forgeWithLesson();
  ({ state } = propose(state, art('model-v2-drifted')));
  assert.match(
    (await rescreen(state, 'model-v2-drifted', run)).decision.reason,
    /proposed/,
    're-screening is for screened candidates; screen runs first'
  );
  ({ state } = await screen(state, 'model-v2-drifted', run));
  ({ state } = await admitLesson(state, dryLesson, run));

  const step = await rescreen(state, 'model-v2-drifted', run);
  assert.equal(step.decision.outcome, 'refused');
  assert.match(step.decision.reason, /lesson-dry/);
  assert.equal(step.state.candidates['model-v2-drifted'].status, 'rejected');
  assert.match(step.state.candidates['model-v2-drifted'].rejectionReason!, /lesson-dry/);
});
