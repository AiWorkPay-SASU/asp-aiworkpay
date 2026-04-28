import fs from "fs";
import path from "path";
import { z } from "zod";

const LessonSchema = z.object({
  id: z.string().uuid(),
  question: z.string(),
  answer: z.string(),
  source: z.enum(["human", "self"]),
  confidence: z.number().min(0).max(1),
  learnedAt: z.string().datetime(),
  usageCount: z.number().int().nonnegative().default(0),
});
export type Lesson = z.infer<typeof LessonSchema>;

const DelegationRecordSchema = z.object({
  id: z.string().uuid(),
  question: z.string(),
  humanResponse: z.string(),
  resolvedAt: z.string().datetime(),
  sessionId: z.string().uuid(),
});
export type DelegationRecord = z.infer<typeof DelegationRecordSchema>;

const LongTermStateSchema = z.object({
  schemaVersion: z.string(),
  createdAt: z.string().datetime(),
  lastUpdatedAt: z.string().datetime(),
  lessons: z.array(LessonSchema),
  delegationHistory: z.array(DelegationRecordSchema),
  globalState: z.object({
    totalIterations: z.number().int().nonnegative(),
    totalDelegations: z.number().int().nonnegative(),
    totalCorrections: z.number().int().nonnegative(),
    sessionCount: z.number().int().nonnegative(),
  }),
});
export type LongTermState = z.infer<typeof LongTermStateSchema>;

const LONG_TERM_PATH = path.resolve(process.cwd(), "src", "memory", "longTerm.json");

export function loadLongTermMemory(): LongTermState {
  const raw = fs.readFileSync(LONG_TERM_PATH, "utf-8");
  return LongTermStateSchema.parse(JSON.parse(raw));
}

export function saveState(state: LongTermState): void {
  const updated: LongTermState = {
    ...state,
    lastUpdatedAt: new Date().toISOString(),
  };
  LongTermStateSchema.parse(updated);
  fs.writeFileSync(LONG_TERM_PATH, JSON.stringify(updated, null, 2), "utf-8");
}

export function addLesson(
  state: LongTermState,
  lesson: Omit<Lesson, "usageCount">
): LongTermState {
  const validated = LessonSchema.parse({ ...lesson, usageCount: 0 });
  const existingIdx = state.lessons.findIndex((l) => l.question === lesson.question);
  if (existingIdx >= 0) {
    const existing = state.lessons[existingIdx];
    const updated = [...state.lessons];
    // Never downgrade a human-validated lesson to a self-derived one.
    // Keep whichever has the better source (human > self) and higher confidence.
    const keepSource =
      existing.source === "human" && lesson.source !== "human"
        ? existing.source
        : lesson.source;
    const keepConfidence = Math.max(existing.confidence, lesson.confidence);
    updated[existingIdx] = {
      ...validated,
      source: keepSource,
      confidence: keepConfidence,
      usageCount: existing.usageCount + 1,
    };
    return { ...state, lessons: updated };
  }
  return { ...state, lessons: [...state.lessons, validated] };
}

export function findLesson(state: LongTermState, question: string): Lesson | null {
  const q = question.toLowerCase();
  return (
    state.lessons.find((l) => l.question.toLowerCase().includes(q) || q.includes(l.question.toLowerCase())) ??
    null
  );
}

export function recordDelegation(
  state: LongTermState,
  record: DelegationRecord
): LongTermState {
  const validated = DelegationRecordSchema.parse(record);
  return {
    ...state,
    delegationHistory: [...state.delegationHistory, validated],
    globalState: {
      ...state.globalState,
      totalDelegations: state.globalState.totalDelegations + 1,
    },
  };
}
