# Claims and the tests that enforce them

Every externally falsifiable claim in `README.md` and in the package
description, with the test that fails if it stops being true. Names are
`file::test name`; run them with `npm test`. Prose that is tone, framing
or provenance is not listed - only statements about behaviour that a
reader could check.

Where a claim has no test, it says so, and why.

## The package description

> Gated self-improvement: lessons that must reproduce, an immunity gate
> that only grows, promote only on a won trial, rollback in one call.

| Claim | Enforced by |
| :-- | :-- |
| lessons must reproduce | `test/forge.test.ts::a lesson that does not reproduce on the incumbent is refused` |
| the immunity gate only grows | `test/forge.test.ts::the suite only grows: no removal API, and new lessons bind future candidates`, `test/forge.test.ts::there is no removal API: the public surface cannot unlearn a lesson` |
| promote only on a won trial | `test/forge.test.ts::losing the trial rejects, with the margin on record`, `test/forge.test.ts::an unscreened candidate cannot stand trial or be promoted` |
| rollback in one call | `test/forge.test.ts::rollback restores the archived incumbent, and needs a reason` |

## The headline

| Claim | Enforced by |
| :-- | :-- |
| a new version ships only if it provably beats the old one | `test/forge.test.ts::the full loop: propose, screen, trial, promote; the incumbent is archived`, `test/forge.test.ts::losing the trial rejects, with the margin on record` |
| you can undo it instantly if it goes wrong | `test/forge.test.ts::rollback restores the archived incumbent, and needs a reason` |
| a pure state machine: no clocks, no generated ids; same inputs, same forge, every time | `test/forge.test.ts::a pure state machine: same inputs, same forge, and the state handed in is untouched` |
| the injected executor is the only thing that ever touches an artifact | no direct test - a negative about I/O cannot be asserted from inside. Indirect: every test and `examples/loop.ts` drive the forge from a lookup table, with no model, network or clock available, which a forge that reached for an artifact itself could not pass |

## The rules

| Claim | Enforced by |
| :-- | :-- |
| a lesson is admitted only if its probe fails on the current incumbent | `test/forge.test.ts::a lesson that does not reproduce on the incumbent is refused`, `test/forge.test.ts::a reproduced, signed lesson is admitted with both facts on record` |
| a lesson is admitted only with a reviewer's name on it | `test/forge.test.ts::a lesson nobody signed is refused: well-formed is not approved` |
| a probe that throws refuses admission instead of escaping | `test/forge.test.ts::a throwing holds predicate refuses admission instead of escaping` |
| every lesson ever admitted runs against every future candidate | `test/forge.test.ts::the suite only grows: no removal API, and new lessons bind future candidates`, `test/forge.test.ts::a candidate that breaks an old lesson is rejected with the lesson named` |
| a lesson admitted after screening blocks promotion by name until a re-screen covers it | `test/forge.test.ts::promotion refuses a candidate the immunity gate has not covered`, `test/forge.test.ts::a re-screen covers the lessons admitted since screening; promotion then earns it`, `test/forge.test.ts::a re-screen that finds a broken lesson rejects the candidate, lesson named` |
| there is no removal API | `test/forge.test.ts::there is no removal API: the public surface cannot unlearn a lesson` |
| an erroring probe is unknown: not a rejection, but promotion refuses | `test/forge.test.ts::an erroring probe is unknown: not a rejection, but promotion refuses` |
| a re-screen adds results and never re-runs one, so unknown stays sticky | `test/forge.test.ts::a re-screen adds results; it never re-runs a lesson, so unknown stays sticky`, `test/forge.test.ts::screening runs once: unknown cannot be cleared by re-rolling a flaky probe` |
| promotion is earned twice: all lessons held, and a trial won | `test/forge.test.ts::the full loop: propose, screen, trial, promote; the incumbent is archived`, `test/forge.test.ts::an unscreened candidate cannot stand trial or be promoted`, `test/forge.test.ts::promotion refuses a candidate the immunity gate has not covered` |
| the trial is scored by your eval, not by the forge | `test/forge.test.ts::losing the trial rejects, with the margin on record` - the verdict is caller-supplied; the forge only records it and acts on it |
| a candidate is bound to the incumbent it was proposed against; if that model stops serving, trial and promotion refuse | `test/forge.test.ts::a candidate is bound to the incumbent it was proposed against`, `test/forge.test.ts::a trial cannot be recorded against an incumbent that has moved on` |
| promotion archives the incumbent instead of discarding it | `test/forge.test.ts::the full loop: propose, screen, trial, promote; the incumbent is archived` |
| rollback needs a reason on the record, and deletes nothing | `test/forge.test.ts::rollback restores the archived incumbent, and needs a reason` |
| state never says promoted about an artifact that is not serving | `test/forge.test.ts::rollback demotes the rolled-back candidate in the record` |
| every refusal is data, a mistyped candidate id included; nothing throws mid-loop | `test/forge.test.ts::an unknown candidate id is a logged refusal, not a thrown error`, `test/forge.test.ts::a throwing holds predicate refuses admission instead of escaping` |
| every decision is logged in order with a reason | `test/forge.test.ts::every decision lands in the log, in order, with a reason` |
| a forge outlives its process: the whole state through JSON and back | `test/persist.test.ts::a forge survives a process boundary: JSON out, forge back in` |
| a predicate the registry cannot supply is an error, never a dropped lesson | `test/persist.test.ts::hydrating without a recorded predicate fails loudly, naming the key`, `test/persist.test.ts::a lesson with no predicate key cannot be serialized`, `test/persist.test.ts::a snapshot from an unknown format version is refused` |

## The quickstart

| Claim | Enforced by |
| :-- | :-- |
| the README shows `examples/loop.ts` verbatim | `test/readme.test.ts::the README quickstart is examples/loop.ts, verbatim` |
| the log in the README is that example's real output | `test/readme.test.ts::the decision log in the README is what examples/loop.ts prints` |
| the example needs no model, network or clock | `test/readme.test.ts::the decision log in the README is what examples/loop.ts prints` runs it as a child process with nothing but the repo on disk; the example also asserts its own end state |
| CI runs the example on every push | `.github/workflows/test.yml`, step `npm run example` - a workflow step, not a unit test |

## Install and develop

| Claim | Enforced by |
| :-- | :-- |
| zero runtime dependencies | `test/readme.test.ts::the package declares zero runtime dependencies` |
| CI packs the tarball and imports it | `.github/workflows/test.yml`, step `install proof` - a workflow step, not a unit test |
| Node 22.18+, erasable-syntax TypeScript, node runs the sources directly | `.github/workflows/test.yml` runs `node --test` over the `.ts` sources on Node 22, 24 and 26; `tsconfig.json` sets `erasableSyntaxOnly`, checked by `npm run typecheck` |
| also installable from a pinned git tag | **not enforced by a test.** It needs the network and a published tag, so CI cannot prove it. The README now says plainly that the npm path is the one CI proves, and that the tag path runs the `prepare` build at install time |

## Not claims

The "Honest limits" section states what the forge does *not* guarantee:
that lesson permanence is convention rather than cryptography, and that
there is no record hash or replay. Those are limits, not claims, and
nothing here enforces them.
