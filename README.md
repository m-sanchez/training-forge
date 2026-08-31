# training-forge

![TypeScript](https://img.shields.io/badge/TypeScript-erasable_syntax-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/node-%3E%3D22.6-5FA04E?logo=nodedotjs&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-B45309)
![Tests](https://img.shields.io/badge/tests-11_passing-2F6F44)
![License](https://img.shields.io/badge/license-MIT-6E6E6E)

Gated self-improvement. A model that learns from itself can just as easily
learn the wrong thing; the forge is the loop that only lets the right
thing through.

[More tools](https://github.com/m-sanchez) ·
[Working rules](https://miguelsanchez.co.uk/ethics) ·
[The case study](https://miguelsanchez.co.uk)

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
  fixed in version 2 cannot come back in version 9.
- **Unknown is neither a pass nor a fail.** A probe that errors during
  screening marks the lesson `unknown`: the candidate is not rejected for
  it, but promotion refuses until someone finds out.
- **Promotion is earned twice.** All lessons held, and a trial won against
  the incumbent - scored by your eval, not by the forge
  ([frozen-eval](https://github.com/m-sanchez/frozen-eval) pairs well).
- **Rollback is one call, with a reason on the record.** Promotion
  archives the incumbent instead of discarding it, and rolling back
  deletes nothing: decisions and lessons survive.

```ts
import { createForge, admitLesson, propose, screen, trial, promote, rollback } from 'training-forge';

let state = createForge({ id: 'model-v1', ref: 'ollama:mine:v1' });

({ state } = await admitLesson(state, {
  id: 'lesson-sum',
  input: 'sum 2 and 2',
  holds: (out) => out.trim() === '4',
  note: 'arithmetic must not regress',
  review: { reviewedBy: 'miguel' }
}, run));

({ state } = propose(state, { id: 'model-v2', ref: 'ollama:mine:v2' }));
({ state } = await screen(state, 'model-v2', run));      // every lesson, forever
({ state } = trial(state, 'model-v2', myEvalVerdict));   // your eval decides
({ state } = promote(state, 'model-v2'));                // v1 archived, not gone

state.decisions;   // every step, in order, with its reason
```

## Run

```bash
npm install       # dev-only: typescript
npm test
npm run typecheck
```

Node 22.6+ (erasable-syntax TypeScript, node runs it directly). Zero
runtime dependencies.

## The tests are the point

| Test | Claim |
| :-- | :-- |
| an unreproduced lesson is refused | a mistake nobody can demonstrate teaches nothing |
| an unsigned lesson is refused | well-formed is not approved; a person signs |
| a candidate that breaks an old lesson is rejected, lesson named | the immunity gate has a memory |
| an erroring probe is unknown, and promotion refuses | an error is neither a pass nor a fail |
| losing the trial rejects, margin on record | promotion is beaten out of the incumbent, not assumed |
| rollback restores the archive and deletes nothing | history survives the retreat |
| new lessons bind future candidates after promotions | the suite only grows |
| every decision is logged in order with a reason | the loop can explain itself |
