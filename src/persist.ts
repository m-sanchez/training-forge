/** Persistence: getting a forge across a process boundary.
 *
 * ForgeState is a plain record except for one thing - Lesson.holds is a
 * function, and functions do not survive JSON. A nightly job that trains,
 * screens and exits would lose the whole accumulated immunity suite, so
 * the "forever" the gate promises would last exactly one process.
 *
 * The split: the predicate lives in your code, published in a registry
 * under a key; the snapshot carries the key. Both halves are required to
 * rebuild a forge, and both directions fail loudly rather than quietly
 * dropping a lesson - a dropped lesson is a weakened gate that still
 * reports "all lessons held". */

import { ForgeError } from './forge.ts';
import type { Artifact, CandidateState, Decision, ForgeState, Lesson } from './forge.ts';

/** Predicate key -> the function it names. The durable half of a lesson. */
export type PredicateRegistry = Record<string, (output: string) => boolean>;

export const SNAPSHOT_VERSION = 1;

/** A lesson with its predicate replaced by the key that names it. */
export interface LessonSnapshot {
  id: string;
  input: string;
  predicate: string;
  note: string;
  review: { reviewedBy: string; note?: string };
}

export interface ForgeSnapshot {
  version: typeof SNAPSHOT_VERSION;
  incumbent: Artifact;
  archive: Artifact[];
  lessons: LessonSnapshot[];
  candidates: Record<string, CandidateState>;
  decisions: Decision[];
}

function copyCandidates(candidates: Record<string, CandidateState>): Record<string, CandidateState> {
  const copy: Record<string, CandidateState> = {};
  for (const [id, c] of Object.entries(candidates)) {
    copy[id] = {
      artifact: { ...c.artifact },
      status: c.status,
      basedOn: c.basedOn,
      immunity: c.immunity.map((r) => ({ ...r })),
      // absent keys stay absent: a snapshot must survive JSON unchanged
      ...(c.trial ? { trial: { ...c.trial } } : {}),
      ...(c.rejectionReason === undefined ? {} : { rejectionReason: c.rejectionReason })
    };
  }
  return copy;
}

/** A JSON-safe snapshot. Refuses a forge holding a lesson whose predicate
 * has no key: a lesson that cannot be rebuilt is a lesson that would come
 * back weaker, and silently. */
export function serializeForge(state: ForgeState): ForgeSnapshot {
  const anonymous = state.lessons.filter((l) => !l.predicate?.trim());
  if (anonymous.length > 0) {
    throw new ForgeError(
      `cannot serialize: no predicate key on ${anonymous.map((l) => `"${l.id}"`).join(', ')}. ` +
        'Give each lesson a predicate key whose function the registry returns at hydration.'
    );
  }
  return {
    version: SNAPSHOT_VERSION,
    incumbent: { ...state.incumbent },
    archive: state.archive.map((a) => ({ ...a })),
    lessons: state.lessons.map((l) => ({
      id: l.id,
      input: l.input,
      predicate: l.predicate!,
      note: l.note,
      review: { ...l.review }
    })),
    candidates: copyCandidates(state.candidates),
    decisions: state.decisions.map((d) => ({ ...d }))
  };
}

/** Rebuild a forge from a snapshot and the registry naming its
 * predicates. Every recorded key must be in the registry: hydrating
 * without one would drop a lesson from the immunity gate while the log
 * still says every lesson held, so a missing key throws. */
export function hydrateForge(snapshot: ForgeSnapshot, registry: PredicateRegistry): ForgeState {
  if (snapshot?.version !== SNAPSHOT_VERSION) {
    throw new ForgeError(
      `unknown snapshot version ${snapshot?.version}; this build reads version ${SNAPSHOT_VERSION}`
    );
  }
  const missing = snapshot.lessons.filter(
    (l) => !Object.hasOwn(registry, l.predicate) || typeof registry[l.predicate] !== 'function'
  );
  if (missing.length > 0) {
    throw new ForgeError(
      `no predicate in the registry for ${missing
        .map((l) => `"${l.id}" (key "${l.predicate}")`)
        .join(', ')}; hydrating without it would weaken the immunity gate in silence`
    );
  }
  const lessons: Lesson[] = snapshot.lessons.map((l) => ({
    id: l.id,
    input: l.input,
    holds: registry[l.predicate],
    predicate: l.predicate,
    note: l.note,
    review: { ...l.review }
  }));
  return {
    incumbent: { ...snapshot.incumbent },
    archive: snapshot.archive.map((a) => ({ ...a })),
    lessons,
    candidates: copyCandidates(snapshot.candidates),
    decisions: snapshot.decisions.map((d) => ({ ...d }))
  };
}
