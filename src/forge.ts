/** The forge: a gated improvement loop as a pure state machine.
 *
 * A model that learns from itself can just as easily learn the wrong
 * thing, so nothing here moves on trust: a lesson must reproduce before it
 * is admitted and must carry a reviewer's name; a candidate must hold
 * every lesson ever admitted and beat the incumbent in a trial the caller
 * scores; promotion archives the incumbent so rollback is one call; and
 * every decision lands in an ordered log with its reason.
 *
 * Every operation is (state, ...) -> { state, decision }. No clocks, no
 * generated ids, no I/O: the same inputs produce the same forge, and the
 * injected executor is the only thing that touches an artifact. */

export interface Artifact {
  id: string;
  /** opaque pointer: a model tag, a prompt version, a config hash */
  ref: string;
}

export interface Lesson {
  id: string;
  /** the probe input that exposed the mistake */
  input: string;
  /** does this output honour the lesson? */
  holds: (output: string) => boolean;
  /** the registry key that names `holds`, if this forge is to be
   * serialized: functions do not survive JSON, keys do. Required by
   * serializeForge, ignored by the state machine itself. */
  predicate?: string;
  note: string;
  /** well-formed is not approved; a person signs every lesson */
  review: { reviewedBy: string; note?: string };
}

export type Run = (artifact: Artifact, input: string) => string | Promise<string>;

export type ImmunityOutcome = 'held' | 'broken' | 'unknown';

export interface ImmunityResult {
  lessonId: string;
  outcome: ImmunityOutcome;
  detail?: string;
}

export type CandidateStatus =
  | 'proposed'
  | 'screened'
  | 'trialed'
  | 'promoted'
  | 'rolled-back'
  | 'rejected';

export interface CandidateState {
  artifact: Artifact;
  status: CandidateStatus;
  /** the incumbent this candidate was proposed against: the model its
   * trial verdict is a comparison with. If the incumbent moves while the
   * candidate is in flight, the verdict is about a model no longer
   * serving, and trial/promote refuse. */
  basedOn: string;
  immunity: ImmunityResult[];
  trial?: { improved: boolean; detail: string };
  rejectionReason?: string;
}

export interface Decision {
  seq: number;
  action: string;
  subject: string;
  outcome: 'accepted' | 'refused' | 'recorded';
  reason: string;
}

export interface ForgeState {
  incumbent: Artifact;
  archive: Artifact[];
  lessons: Lesson[];
  candidates: Record<string, CandidateState>;
  decisions: Decision[];
}

export interface Step {
  state: ForgeState;
  decision: Decision;
}

export class ForgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeError';
  }
}

export function createForge(incumbent: Artifact): ForgeState {
  return { incumbent, archive: [], lessons: [], candidates: {}, decisions: [] };
}

function decide(
  state: ForgeState,
  action: string,
  subject: string,
  outcome: Decision['outcome'],
  reason: string
): Step {
  const decision: Decision = { seq: state.decisions.length, action, subject, outcome, reason };
  return { state: { ...state, decisions: [...state.decisions, decision] }, decision };
}

/** Admit a lesson. Two gates: a reviewer's name, and reproduction - the
 * probe must fail on the current incumbent. A lesson nobody signed is not
 * approved; a lesson that does not reproduce teaches nothing. Admitted
 * lessons are permanent: the immunity suite only grows. */
export async function admitLesson(state: ForgeState, lesson: Lesson, run: Run): Promise<Step> {
  if (!lesson.review?.reviewedBy) {
    return decide(state, 'admit-lesson', lesson.id, 'refused', 'no reviewer signed it; well-formed is not approved');
  }
  if (state.lessons.some((l) => l.id === lesson.id)) {
    return decide(state, 'admit-lesson', lesson.id, 'refused', 'a lesson with this id is already admitted');
  }
  let held: boolean;
  try {
    const output = await run(state.incumbent, lesson.input);
    held = lesson.holds(output);
  } catch (err) {
    // run OR holds throwing lands here: a lesson that cannot be evaluated
    // cannot be admitted, and the forge never leaks the exception
    return decide(state, 'admit-lesson', lesson.id, 'refused', `the probe could not be evaluated on the incumbent: ${err}`);
  }
  if (held) {
    return decide(
      state,
      'admit-lesson',
      lesson.id,
      'refused',
      'the incumbent already honours this lesson; a mistake that does not reproduce teaches nothing'
    );
  }
  const next = { ...state, lessons: [...state.lessons, lesson] };
  return decide(next, 'admit-lesson', lesson.id, 'accepted', `reproduced on ${state.incumbent.id}, signed by ${lesson.review.reviewedBy}`);
}

export function propose(state: ForgeState, artifact: Artifact): Step {
  if (state.candidates[artifact.id]) {
    return decide(state, 'propose', artifact.id, 'refused', 'a candidate with this id already exists');
  }
  const next: ForgeState = {
    ...state,
    candidates: {
      ...state.candidates,
      [artifact.id]: { artifact, status: 'proposed', basedOn: state.incumbent.id, immunity: [] }
    }
  };
  return decide(next, 'propose', artifact.id, 'accepted', `candidate enters the loop at the immunity gate, against ${state.incumbent.id}`);
}

function findCandidate(state: ForgeState, id: string): CandidateState | undefined {
  return Object.hasOwn(state.candidates, id) ? state.candidates[id] : undefined;
}

/** A candidate's trial is a comparison with the incumbent it was proposed
 * against. If that incumbent has been replaced, the comparison is with a
 * model that no longer serves, and nothing here can rescue it: only a new
 * measurement can. Returns the reason to refuse, or undefined. */
function incumbentMoved(state: ForgeState, candidate: CandidateState): string | undefined {
  if (state.incumbent.id === candidate.basedOn) return undefined;
  return (
    `the incumbent moved from ${candidate.basedOn} to ${state.incumbent.id} since this candidate ` +
    `was proposed; it was measured against a model that no longer serves - propose it again against ${state.incumbent.id}`
  );
}

/** Lessons this candidate has no recorded result for: admitted after it
 * was screened, so they bind nothing until it is re-screened. */
function uncoveredLessons(state: ForgeState, candidate: CandidateState): Lesson[] {
  const covered = new Set(candidate.immunity.map((r) => r.lessonId));
  return state.lessons.filter((l) => !covered.has(l.id));
}

function withCandidate(state: ForgeState, id: string, patch: Partial<CandidateState>): ForgeState {
  return {
    ...state,
    candidates: { ...state.candidates, [id]: { ...state.candidates[id], ...patch } }
  };
}

/** The immunity gate: every lesson ever admitted runs against the
 * candidate. broken rejects, with the lessons named. unknown (the probe
 * errored) neither passes nor fails: the candidate stays unpromotable
 * until someone finds out. */
export async function screen(state: ForgeState, candidateId: string, run: Run): Promise<Step> {
  const candidate = findCandidate(state, candidateId);
  if (!candidate) {
    return decide(state, 'screen', candidateId, 'refused', `no candidate "${candidateId}"`);
  }
  if (candidate.status !== 'proposed') {
    // one screening per candidate: re-running until a flaky probe passes
    // would let unknown quietly become held
    return decide(state, 'screen', candidateId, 'refused', `cannot screen a ${candidate.status} candidate; screening runs once and unknown stays sticky`);
  }
  const immunity: ImmunityResult[] = [];
  for (const lesson of state.lessons) {
    try {
      const output = await run(candidate.artifact, lesson.input);
      immunity.push(
        lesson.holds(output)
          ? { lessonId: lesson.id, outcome: 'held' }
          : { lessonId: lesson.id, outcome: 'broken', detail: lesson.note }
      );
    } catch (err) {
      immunity.push({ lessonId: lesson.id, outcome: 'unknown', detail: `probe error: ${err}` });
    }
  }
  const broken = immunity.filter((r) => r.outcome === 'broken');
  const unknown = immunity.filter((r) => r.outcome === 'unknown');
  if (broken.length > 0) {
    const reason = `broke ${broken.length} lesson(s): ${broken.map((b) => b.lessonId).join(', ')}`;
    return decide(
      withCandidate(state, candidateId, { status: 'rejected', immunity, rejectionReason: reason }),
      'screen',
      candidateId,
      'refused',
      reason
    );
  }
  const next = withCandidate(state, candidateId, { status: 'screened', immunity });
  return decide(
    next,
    'screen',
    candidateId,
    'accepted',
    unknown.length > 0
      ? `${immunity.length - unknown.length} lesson(s) held; ${unknown.length} unknown (${unknown
          .map((u) => u.lessonId)
          .join(', ')}) - unpromotable until resolved`
      : `all ${immunity.length} lesson(s) held`
  );
}

/** Additive re-screening, for lessons admitted after this candidate was
 * screened. It runs those lessons and only those: a result already on the
 * record is never re-run, so an unknown cannot be re-rolled into a held.
 * A lesson that comes back broken rejects the candidate exactly as it
 * would at the gate. Without this, "every lesson ever admitted runs
 * against every future candidate" would be unreachable for a candidate
 * already in flight - promote() refuses it, and nothing could clear it. */
export async function rescreen(state: ForgeState, candidateId: string, run: Run): Promise<Step> {
  const candidate = findCandidate(state, candidateId);
  if (!candidate) {
    return decide(state, 're-screen', candidateId, 'refused', `no candidate "${candidateId}"`);
  }
  if (candidate.status !== 'screened' && candidate.status !== 'trialed') {
    return decide(state, 're-screen', candidateId, 'refused', `cannot re-screen a ${candidate.status} candidate; screening comes first`);
  }
  const outstanding = uncoveredLessons(state, candidate);
  if (outstanding.length === 0) {
    return decide(
      state,
      're-screen',
      candidateId,
      'refused',
      'every admitted lesson already has a result; a recorded result is never re-run and unknown stays sticky'
    );
  }
  const added: ImmunityResult[] = [];
  for (const lesson of outstanding) {
    try {
      const output = await run(candidate.artifact, lesson.input);
      added.push(
        lesson.holds(output)
          ? { lessonId: lesson.id, outcome: 'held' }
          : { lessonId: lesson.id, outcome: 'broken', detail: lesson.note }
      );
    } catch (err) {
      added.push({ lessonId: lesson.id, outcome: 'unknown', detail: `probe error: ${err}` });
    }
  }
  const immunity = [...candidate.immunity, ...added];
  const broken = added.filter((r) => r.outcome === 'broken');
  const unknown = added.filter((r) => r.outcome === 'unknown');
  const names = added.map((r) => r.lessonId).join(', ');
  if (broken.length > 0) {
    const reason = `broke ${broken.length} lesson(s) admitted since screening: ${broken.map((b) => b.lessonId).join(', ')}`;
    return decide(
      withCandidate(state, candidateId, { status: 'rejected', immunity, rejectionReason: reason }),
      're-screen',
      candidateId,
      'refused',
      reason
    );
  }
  return decide(
    withCandidate(state, candidateId, { immunity }),
    're-screen',
    candidateId,
    'accepted',
    unknown.length > 0
      ? `covered ${added.length} lesson(s) admitted since screening (${names}); ${unknown.length} unknown (${unknown
          .map((u) => u.lessonId)
          .join(', ')}) - unpromotable until resolved`
      : `covered ${added.length} lesson(s) admitted since screening: ${names}; all held`
  );
}

/** Record the trial verdict. The forge does not score candidates; your
 * eval does (frozen-eval pairs well). Losing the trial rejects. */
export function trial(state: ForgeState, candidateId: string, verdict: { improved: boolean; detail: string }): Step {
  const candidate = findCandidate(state, candidateId);
  if (!candidate) {
    return decide(state, 'trial', candidateId, 'refused', `no candidate "${candidateId}"`);
  }
  if (candidate.status !== 'screened') {
    return decide(state, 'trial', candidateId, 'refused', `only a screened candidate can stand trial (is: ${candidate.status})`);
  }
  const moved = incumbentMoved(state, candidate);
  if (moved) {
    return decide(state, 'trial', candidateId, 'refused', moved);
  }
  if (!verdict.improved) {
    const reason = `did not beat the incumbent: ${verdict.detail}`;
    return decide(
      withCandidate(state, candidateId, { status: 'rejected', trial: verdict, rejectionReason: reason }),
      'trial',
      candidateId,
      'refused',
      reason
    );
  }
  return decide(
    withCandidate(state, candidateId, { status: 'trialed', trial: verdict }),
    'trial',
    candidateId,
    'accepted',
    `beat the incumbent: ${verdict.detail}`
  );
}

/** Promotion: all lessons held, no unknowns outstanding, trial won. The
 * incumbent is archived, not discarded - rollback is one call away. */
export function promote(state: ForgeState, candidateId: string): Step {
  const candidate = findCandidate(state, candidateId);
  if (!candidate) {
    return decide(state, 'promote', candidateId, 'refused', `no candidate "${candidateId}"`);
  }
  if (candidate.status !== 'trialed') {
    return decide(state, 'promote', candidateId, 'refused', `only a trialed candidate can be promoted (is: ${candidate.status})`);
  }
  const moved = incumbentMoved(state, candidate);
  if (moved) {
    return decide(state, 'promote', candidateId, 'refused', moved);
  }
  // "every lesson ever admitted" includes the ones admitted after this
  // candidate was screened: a lesson with no result binds nothing
  const uncovered = uncoveredLessons(state, candidate);
  if (uncovered.length > 0) {
    return decide(
      state,
      'promote',
      candidateId,
      'refused',
      `no immunity result for: ${uncovered.map((l) => l.id).join(', ')}; ` +
        `${uncovered.length} lesson(s) admitted since screening - re-screen this candidate`
    );
  }
  const unknown = candidate.immunity.filter((r) => r.outcome === 'unknown');
  if (unknown.length > 0) {
    return decide(
      state,
      'promote',
      candidateId,
      'refused',
      `immunity unknown for: ${unknown.map((u) => u.lessonId).join(', ')}; an error is neither a pass nor a fail`
    );
  }
  const next: ForgeState = {
    ...withCandidate(state, candidateId, { status: 'promoted' }),
    incumbent: candidate.artifact,
    archive: [...state.archive, state.incumbent]
  };
  return decide(next, 'promote', candidateId, 'accepted', `${candidate.artifact.id} is the incumbent; ${state.incumbent.id} archived for rollback`);
}

/** Instant rollback to the previous incumbent, reason mandatory. Nothing
 * is deleted: decisions and lessons survive every rollback. */
export function rollback(state: ForgeState, reason: string): Step {
  if (!reason?.trim()) {
    return decide(state, 'rollback', state.incumbent.id, 'refused', 'rollback needs a reason on the record');
  }
  const previous = state.archive[state.archive.length - 1];
  if (!previous) {
    return decide(state, 'rollback', state.incumbent.id, 'refused', 'nothing archived to roll back to');
  }
  // the candidate that was the incumbent is demoted in the record too, so
  // state never says "promoted" about an artifact that is no longer serving
  const demotedId = Object.values(state.candidates).find(
    (c) => c.status === 'promoted' && c.artifact.id === state.incumbent.id
  )?.artifact.id;
  const next: ForgeState = {
    ...(demotedId ? withCandidate(state, demotedId, { status: 'rolled-back' }) : state),
    incumbent: previous,
    archive: state.archive.slice(0, -1)
  };
  return decide(next, 'rollback', previous.id, 'recorded', `restored ${previous.id}; reason: ${reason}`);
}
