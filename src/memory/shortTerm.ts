import { z } from "zod";

export const ActionSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  plannedAt: z.string().datetime(),
  executedAt: z.string().datetime().optional(),
  outcome: z.string().optional(),
  confidence: z.number().min(0).max(1),
  delegatedToHuman: z.boolean().default(false),
  humanResponse: z.string().optional(),
  estimatedCostUSD: z.number().nonnegative().default(0),
});
export type Action = z.infer<typeof ActionSchema>;

export const ThinkStepSchema = z.object({
  iteration: z.number().int().nonnegative(),
  goal: z.string(),
  analysis: z.string(),
  proposedAction: ActionSchema,
  critiqueScore: z.number().min(0).max(1),
  critiqueNote: z.string(),
  decision: z.enum(["EXECUTE", "DELEGATE", "ABORT"]),
  timestamp: z.string().datetime(),
});
export type ThinkStep = z.infer<typeof ThinkStepSchema>;

export const ShortTermContextSchema = z.object({
  sessionId: z.string().uuid(),
  startedAt: z.string().datetime(),
  currentGoal: z.string(),
  currentIteration: z.number().int().nonnegative(),
  delegationsThisSession: z.number().int().nonnegative(),
  pendingDelegationId: z.string().uuid().nullable(),
  history: z.array(ThinkStepSchema),
  pendingAction: ActionSchema.nullable(),
});
export type ShortTermContext = z.infer<typeof ShortTermContextSchema>;

export class ShortTermMemory {
  private ctx: ShortTermContext;

  constructor(sessionId: string, initialGoal: string) {
    this.ctx = ShortTermContextSchema.parse({
      sessionId,
      startedAt: new Date().toISOString(),
      currentGoal: initialGoal,
      currentIteration: 0,
      delegationsThisSession: 0,
      pendingDelegationId: null,
      history: [],
      pendingAction: null,
    });
  }

  get context(): ShortTermContext {
    return this.ctx;
  }

  pushStep(step: ThinkStep): void {
    ThinkStepSchema.parse(step);
    this.ctx.history.push(step);
    this.ctx.currentIteration = step.iteration + 1;
  }

  setPendingAction(action: Action | null): void {
    this.ctx.pendingAction = action;
  }

  setPendingDelegation(id: string | null): void {
    this.ctx.pendingDelegationId = id as string | null;
  }

  incrementDelegations(): void {
    this.ctx.delegationsThisSession += 1;
  }

  setGoal(goal: string): void {
    this.ctx.currentGoal = goal;
  }

  lastStep(): ThinkStep | null {
    return this.ctx.history.at(-1) ?? null;
  }
}
