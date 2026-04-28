import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { logStep } from "./logger";
import {
  LongTermState,
  addLesson,
  saveState,
} from "./memory/persistence";
import { Action, ThinkStep } from "./memory/shortTerm";
import { CONSTITUTION } from "./config/constitution";

// ── Critique result ─────────────────────────────────────────────────────────
export const CritiqueResultSchema = z.object({
  score: z.number().min(0).max(1),
  note: z.string(),
  hallucinationDetected: z.boolean(),
  correctionApplied: z.boolean(),
  correctedAction: z
    .object({
      type: z.string(),
      payload: z.record(z.string(), z.unknown()),
    })
    .optional(),
});
export type CritiqueResult = z.infer<typeof CritiqueResultSchema>;

// ── Post-execution audit ────────────────────────────────────────────────────
export const AuditResultSchema = z.object({
  consistent: z.boolean(),
  divergenceNote: z.string().optional(),
  correctionLesson: z.string().optional(),
});
export type AuditResult = z.infer<typeof AuditResultSchema>;

// ── ResidualAgent ───────────────────────────────────────────────────────────
export class ResidualAgent {
  private ltMemory: LongTermState;

  constructor(ltMemory: LongTermState) {
    this.ltMemory = ltMemory;
  }

  /**
   * Pre-execution critique: evaluate the proposed action before it runs.
   * Returns a confidence score and flags potential hallucinations.
   */
  critique(step: Omit<ThinkStep, "critiqueScore" | "critiqueNote" | "decision" | "timestamp">): CritiqueResult {
    const action = step.proposedAction;

    // Check against prohibited actions
    if (CONSTITUTION.prohibitedActions.includes(action.type)) {
      logStep("CRITICIZE", `Prohibited action detected: ${action.type}`);
      return CritiqueResultSchema.parse({
        score: 0,
        note: `Action "${action.type}" is explicitly prohibited by the constitution.`,
        hallucinationDetected: false,
        correctionApplied: false,
      });
    }

    // Check if the payload references a known lesson that contradicts the plan
    const payloadStr = JSON.stringify(action.payload).toLowerCase();
    const contradictions = this.ltMemory.lessons.filter((l) => {
      const lessonKey = l.question.toLowerCase();
      return payloadStr.includes(lessonKey) && l.confidence > 0.8 && action.confidence > l.confidence + 0.1;
    });

    if (contradictions.length > 0) {
      const lesson = contradictions[0];
      logStep("CRITICIZE", `Possible hallucination vs stored lesson: "${lesson.question}"`);
      return CritiqueResultSchema.parse({
        score: Math.min(action.confidence, lesson.confidence) * 0.7,
        note: `Stored lesson contradicts confidence level. Known fact: "${lesson.answer}"`,
        hallucinationDetected: true,
        correctionApplied: true,
        correctedAction: {
          type: action.type,
          payload: { ...action.payload, correctedAnswer: lesson.answer },
        },
      });
    }

    // For unknown-domain questions, lower confidence proportionally
    const unknownDomainPatterns = ["atlantis", "fictional", "mythical", "legend"];
    const isUnknownDomain = unknownDomainPatterns.some((p) => payloadStr.includes(p));

    // Skip domain penalty if the answer was already validated by a human
    const isHumanSourced = (action.payload as Record<string, unknown>)["source"] === "human";
    if (isUnknownDomain && !isHumanSourced && action.confidence > CONSTITUTION.riskTolerance.confidenceThreshold) {
      logStep("CRITICIZE", "Unknown/uncertain domain detected — reducing confidence");
      return CritiqueResultSchema.parse({
        score: 0.6,
        note: "Domain involves mythological/uncertain subject matter. Confidence adjusted down.",
        hallucinationDetected: false,
        correctionApplied: false,
      });
    }

    // Default: pass through with slight confidence discount
    const score = Math.min(action.confidence * 0.98, 1.0);
    return CritiqueResultSchema.parse({
      score,
      note: score >= CONSTITUTION.riskTolerance.confidenceThreshold
        ? "Action appears safe and well-grounded."
        : "Confidence below threshold — escalation recommended.",
      hallucinationDetected: false,
      correctionApplied: false,
    });
  }

  /**
   * Post-execution audit: compare what was planned vs what happened.
   * Logs corrections to long-term memory.
   */
  async audit(
    step: ThinkStep,
    actualOutcome: string
  ): Promise<AuditResult> {
    const planned = step.proposedAction.outcome ?? "(no planned outcome recorded)";
    const consistent = this.textSimilarity(planned, actualOutcome) > 0.4;

    logStep("CORRECT", `Audit — planned: "${planned}" | actual: "${actualOutcome}" | consistent: ${consistent}`);

    if (!consistent) {
      const correctionLesson = `When asked "${step.goal}", planned outcome differed from actual. Actual: ${actualOutcome}`;
      this.ltMemory = addLesson(this.ltMemory, {
        id: uuidv4(),
        question: step.goal,
        answer: actualOutcome,
        source: "self",
        confidence: 0.7,
        learnedAt: new Date().toISOString(),
      });
      saveState(this.ltMemory);

      this.ltMemory = {
        ...this.ltMemory,
        globalState: {
          ...this.ltMemory.globalState,
          totalCorrections: this.ltMemory.globalState.totalCorrections + 1,
        },
      };
      saveState(this.ltMemory);

      return AuditResultSchema.parse({ consistent: false, divergenceNote: correctionLesson, correctionLesson });
    }

    return AuditResultSchema.parse({ consistent: true });
  }

  updateMemory(ltMemory: LongTermState): void {
    this.ltMemory = ltMemory;
  }

  get memory(): LongTermState {
    return this.ltMemory;
  }

  private textSimilarity(a: string, b: string): number {
    if (!a || !b) return 0;
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
    return intersection / Math.max(wordsA.size, wordsB.size);
  }
}
