/** The whole loop, end to end, against a lookup table: no model, no
 * network, no clock. `npm run example` runs this file, CI runs it on every
 * push, and the decision log in the README is this program's output. */

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
} from '../src/index.ts';
import type { Artifact, ForgeState, Lesson, Run, Step } from '../src/index.ts';

/** Model versions as behaviour tables: input -> output. The executor reads
 * them; the forge never does. Swap this for a real model call. */
const BEHAVIOURS: Record<string, Record<string, string>> = {
  'model-v1': { 'sum 2 and 2': '5', 'is it raining': 'yes' },
  'model-v2': { 'sum 2 and 2': '4', 'is it raining': 'no' },
  'model-v2-regressive': { 'sum 2 and 2': '5', 'is it raining': 'no' }
};

const run: Run = (artifact, input) => {
  const output = BEHAVIOURS[artifact.ref]?.[input];
  if (output === undefined) throw new Error(`no behaviour for "${input}"`);
  return output;
};

const artifact = (id: string): Artifact => ({ id, ref: id });

const arithmetic: Lesson = {
  id: 'lesson-sum',
  input: 'sum 2 and 2',
  holds: (out) => out.trim() === '4',
  note: 'arithmetic must not regress',
  review: { reviewedBy: 'miguel' }
};

const weather: Lesson = {
  id: 'lesson-dry',
  input: 'is it raining',
  holds: (out) => out.trim() === 'no',
  note: 'rain reported out of a clear sky',
  review: { reviewedBy: 'miguel' }
};

let state: ForgeState = createForge(artifact('model-v1'));
/** Every call returns { state, decision }: carry the state forward. */
const advance = (step: Step): void => void (state = step.state);

advance(await admitLesson(state, arithmetic, run));      // reproduces on v1
advance(propose(state, artifact('model-v2-regressive')));
advance(await screen(state, 'model-v2-regressive', run)); // brings the bug back
advance(propose(state, artifact('model-v2')));
advance(await screen(state, 'model-v2', run));
advance(await admitLesson(state, weather, run));          // a mistake found later
advance(trial(state, 'model-v2', { improved: true, detail: 'exact 0.91 vs 0.74' }));
advance(promote(state, 'model-v2'));                      // the new lesson binds it
advance(await rescreen(state, 'model-v2', run));
advance(promote(state, 'model-v2'));
advance(rollback(state, 'v2 misreads dates on live traffic'));

for (const d of state.decisions) {
  console.log(
    `${String(d.seq).padStart(2)}  ${d.action.padEnd(12)} ${d.subject.padEnd(19)} ${d.outcome.padEnd(8)} ${d.reason}`
  );
}

// the example is a check too: CI fails if the loop stops behaving
assert.equal(state.incumbent.id, 'model-v1', 'the rollback put v1 back');
assert.equal(state.candidates['model-v2'].status, 'rolled-back');
