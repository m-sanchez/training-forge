# training-forge

![TypeScript](https://img.shields.io/badge/TypeScript-erasable_syntax-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/node-%3E%3D22.18-5FA04E?logo=nodedotjs&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-B45309)
[![CI](https://github.com/m-sanchez/training-forge/actions/workflows/test.yml/badge.svg)](https://github.com/m-sanchez/training-forge/actions/workflows/test.yml)
![License](https://img.shields.io/badge/license-MIT-6E6E6E)
[![npm](https://img.shields.io/npm/v/@m-sanchez/training-forge?color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@m-sanchez/training-forge)

> **In plain English:** a model learns from corrections safely: a new version ships only if it provably beats the old one, and you can undo it instantly if it goes wrong.

Gated self-improvement. A model that learns from itself can just as easily
learn the wrong thing; the forge is the loop that only lets the right
thing through.

[More tools](https://github.com/m-sanchez) ·
[Working rules](https://miguelsanchez.co.uk/ethics) ·
[The case study](https://miguelsanchez.co.uk)

*Provenance: this came out of one body of production LLM work, extracted and
generalised into a standalone package. First published 2026-08-31.*

```
mistake -> lesson -> immunity gate -> trial -> promote | rollback
```

A pure state machine over explicit records - no clocks, no I/O, no
generated ids; the injected executor is the only thing that ever touches
an artifact. Same inputs, same forge, every time.

- **Lessons must reproduce.** A lesson is admitted only if its probe
  actually fails on the current incumbent, and only with a reviewer's
  name on it. A mistake nobody can demonstrate teaches nothing;
  well-formed is not approved.
- **The immunity gate only grows.** There is no removal API. Every lesson
  ever admitted runs against every future candidate, forever; the bug
  fixed in version 2 cannot come back in version 9. A lesson admitted
  after a candidate was screened blocks that candidate's promotion by
  name until `rescreen` covers it - "forever" includes the ones that
  arrived late.
- **Unknown is neither a pass nor a fail.** A probe that errors during
  screening marks the lesson `unknown`: the candidate is not rejected for
  it, but promotion refuses until someone finds out. A re-screen adds
  results, it never re-runs one, so unknown stays sticky.
- **Promotion is earned twice.** All lessons held, and a trial won against
  the incumbent - scored by your eval, not by the forge
  ([frozen-eval](https://github.com/m-sanchez/frozen-eval) pairs well).
  A candidate is bound to the incumbent it was proposed against: if that
  model stops serving, the verdict is about something else, and trial and
  promotion refuse.
- **Rollback is one call, with a reason on the record.** Promotion
  archives the incumbent instead of discarding it, and rolling back
  deletes nothing: decisions and lessons survive.
- **Every refusal is data.** A broken lesson, an outstanding unknown, a
  moved incumbent, even a mistyped candidate id: all of them land in the
  decision log with a reason. Nothing throws at you mid-loop.
- **A forge outlives its process.** `serializeForge` and `hydrateForge`
  carry the whole state through JSON, with each lesson's predicate named
  by a key your registry supplies; a key the registry cannot supply is an
  error, never a quietly dropped lesson.

## The loop, end to end

`examples/loop.ts` drives the whole thing from a lookup table: no model, no
network, no clock. `npm run example` runs it, CI runs it on every push, and
the log below is its real output. In your own project the import is
`@m-sanchez/training-forge`.

```ts
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
```

Its decision log - the artifact the library exists to produce:

```
 0  admit-lesson lesson-sum          accepted reproduced on model-v1, signed by miguel
 1  propose      model-v2-regressive accepted candidate enters the loop at the immunity gate, against model-v1
 2  screen       model-v2-regressive refused  broke 1 lesson(s): lesson-sum
 3  propose      model-v2            accepted candidate enters the loop at the immunity gate, against model-v1
 4  screen       model-v2            accepted all 1 lesson(s) held
 5  admit-lesson lesson-dry          accepted reproduced on model-v1, signed by miguel
 6  trial        model-v2            accepted beat the incumbent: exact 0.91 vs 0.74
 7  promote      model-v2            refused  no immunity result for: lesson-dry; 1 lesson(s) admitted since screening - re-screen this candidate
 8  re-screen    model-v2            accepted covered 1 lesson(s) admitted since screening: lesson-dry; all held
 9  promote      model-v2            accepted model-v2 is the incumbent; model-v1 archived for rollback
10  rollback     model-v1            recorded restored model-v1; reason: v2 misreads dates on live traffic
```

## Install

```bash
npm install @m-sanchez/training-forge
```

Also installable from a pinned git tag, e.g.
`github:m-sanchez/training-forge#v3.0.0`. That path runs the `prepare`
build at install time; what CI proves is the npm path - it packs the
tarball and imports it. Zero runtime dependencies.

## Develop

```bash
npm ci            # dev-only: typescript
npm test
npm run typecheck
npm run example   # the decision log above, printed fresh
```

Node 22.18+ (erasable-syntax TypeScript; node runs the sources directly).

## Honest limits

- Lessons are permanent by convention, not by force: `ForgeState` is a
  plain object, and code that rewrites it can drop lessons. The forge
  offers no API for it, which is a design stance, not a cryptographic one.
- A forge crosses a process boundary only through `serializeForge` and
  `hydrateForge`, and only for lessons that name their predicate with a
  `predicate` key. Both directions throw rather than drop a lesson,
  because a missing predicate is a weakened gate that would still report
  every lesson held.
- There is still no record hash and no replay here: the forge stores what
  your executor answered, not proof that it would answer the same way
  tomorrow. If you need frozen, replayable evaluation, that is what
  [frozen-eval](https://github.com/m-sanchez/frozen-eval) is for, and the
  trial slot is where it plugs in.

## The tests are the point

Every claim above maps to a test in [CLAIMS.md](CLAIMS.md).

| Test | Claim |
| :-- | :-- |
| an unreproduced lesson is refused | a mistake nobody can demonstrate teaches nothing |
| an unsigned lesson is refused | well-formed is not approved; a person signs |
| a candidate that breaks an old lesson is rejected, lesson named | the immunity gate has a memory |
| an erroring probe is unknown, and promotion refuses | an error is neither a pass nor a fail |
| losing the trial rejects, margin on record | promotion is beaten out of the incumbent, not assumed |
| rollback restores the archive, demotes the candidate, deletes nothing | state never says promoted about what is not serving |
| screening runs once; unknown is sticky | a flaky probe cannot be re-rolled into a pass |
| a throwing holds predicate refuses admission | the forge contains its plug-in point |
| new lessons bind future candidates after promotions | the suite only grows |
| promotion refuses a candidate the gate has not covered | forever includes the lessons admitted late |
| a re-screen covers those lessons and never re-runs one | coverage grows; recorded results do not move |
| a candidate is bound to the incumbent it was measured against | a verdict is about the model it compared with |
| a forge survives JSON out and back in | the suite outlives the process that built it |
| hydrating without a recorded predicate throws | a missing predicate never weakens the gate in silence |
| a mistyped candidate id is a logged refusal | every failure is data, operator error included |
| the README quickstart is the file CI runs, output and all | the quickstart cannot rot into fiction |
| every decision is logged in order with a reason | the loop can explain itself |
