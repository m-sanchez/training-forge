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

export type CandidateStatus = 'proposed' | 'screened' | 'trialed' | 'promoted' | 'rejected';

export interface CandidateState {
  artifact: Artifact;
  status: CandidateStatus;
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
  let output: string;
  try {
    output = await run(state.incumbent, lesson.input);
  } catch (err) {
    return decide(state, 'admit-lesson', lesson.id, 'refused', `the probe could not run on the incumbent: ${err}`);
  }
  if (lesson.holds(output)) {
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
      [artifact.id]: { artifact, status: 'proposed', immunity: [] }
    }
  };
  return decide(next, 'propose', artifact.id, 'accepted', 'candidate enters the loop at the immunity gate');
}

function requireCandidate(state: ForgeState, id: string): CandidateState {
  const candidate = state.candidates[id];
  if (!candidate) throw new ForgeError(`no candidate "${id}"`);
  return candidate;
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
  const candidate = requireCandidate(state, candidateId);
  if (candidate.status !== 'proposed' && candidate.status !== 'screened') {
    return decide(state, 'screen', candidateId, 'refused', `cannot screen a ${candidate.status} candidate`);
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

/** Record the trial verdict. The forge does not score candidates; your
 * eval does (frozen-eval pairs well). Losing the trial rejects. */
export function trial(state: ForgeState, candidateId: string, verdict: { improved: boolean; detail: string }): Step {
  const candidate = requireCandidate(state, candidateId);
  if (candidate.status !== 'screened') {
    return decide(state, 'trial', candidateId, 'refused', `only a screened candidate can stand trial (is: ${candidate.status})`);
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
  const candidate = requireCandidate(state, candidateId);
  if (candidate.status !== 'trialed') {
    return decide(state, 'promote', candidateId, 'refused', `only a trialed candidate can be promoted (is: ${candidate.status})`);
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
  const next: ForgeState = {
    ...state,
    incumbent: previous,
    archive: state.archive.slice(0, -1)
  };
  return decide(next, 'rollback', previous.id, 'recorded', `restored ${previous.id}; reason: ${reason}`);
}
