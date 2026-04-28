import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { AIWorkPayClient, DelegationRequest, DelegationResponse, DelegationResponseSchema } from "../sdk/aiworkpay";
import { logStep } from "../logger";
import { CONSTITUTION } from "../config/constitution";

// ── Circuit-breaker states ──────────────────────────────────────────────────
type CBState = "CLOSED" | "OPEN" | "HALF_OPEN";

const CircuitBreakerConfigSchema = z.object({
  failureThreshold: z.number().int().positive().default(3),
  recoveryTimeMs: z.number().positive().default(60_000),
});
type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;

class CircuitBreaker {
  private state: CBState = "CLOSED";
  private failures = 0;
  private lastFailureAt = 0;
  private readonly cfg: CircuitBreakerConfig;

  constructor(cfg: Partial<CircuitBreakerConfig> = {}) {
    this.cfg = CircuitBreakerConfigSchema.parse({ ...cfg });
  }

  isOpen(): boolean {
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureAt > this.cfg.recoveryTimeMs) {
        this.state = "HALF_OPEN";
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = "CLOSED";
  }

  recordFailure(): void {
    this.failures += 1;
    this.lastFailureAt = Date.now();
    if (this.failures >= this.cfg.failureThreshold) {
      this.state = "OPEN";
      logStep("DELEGATE", `Circuit breaker OPENED after ${this.failures} failures`);
    }
  }

  get currentState(): CBState {
    return this.state;
  }
}

// ── Delegation result schema ────────────────────────────────────────────────
export const DelegationResultSchema = z.object({
  taskId: z.string().uuid(),
  question: z.string(),
  answer: z.string(),
  validatedBy: z.string(),
  resolvedAt: z.string().datetime(),
  timedOut: z.boolean().default(false),
});
export type DelegationResult = z.infer<typeof DelegationResultSchema>;

// ── TrustLayer ──────────────────────────────────────────────────────────────
export class TrustLayer {
  private readonly client: AIWorkPayClient;
  private readonly cb: CircuitBreaker;
  private readonly pollIntervalMs: number;

  constructor(
    apiKey: string,
    baseUrl?: string,
    pollIntervalMs = 5_000
  ) {
    this.client = new AIWorkPayClient(apiKey, baseUrl);
    this.cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 30_000 });
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Delegates a question to a human validator via AIWorkPay.
   * Pauses execution (awaits) until a response arrives or timeout fires.
   * Implements circuit-breaker to avoid hammering a failing endpoint.
   */
  async delegate(
    question: string,
    context: string,
    agentId: string,
    sessionId: string
  ): Promise<DelegationResult> {
    if (this.cb.isOpen()) {
      logStep("DELEGATE", "Circuit breaker is OPEN — using fallback answer");
      return this.fallbackResult(question, "Circuit breaker open; human validation unavailable.");
    }

    const taskId = uuidv4();
    const request: DelegationRequest = DelegationRequest_safe({
      taskId,
      question,
      context,
      requesterAgentId: agentId,
      timeoutSeconds: CONSTITUTION.escalationPolicy.humanTimeoutSeconds,
    });

    logStep("DELEGATE", `Submitting task ${taskId}`, { question });

    let submission: DelegationResponse;
    try {
      submission = await this.client.submitTask(request);
    } catch (err) {
      this.cb.recordFailure();
      logStep("DELEGATE", `Submission failed: ${(err as Error).message}`);
      return this.fallbackResult(question, "Submission error; could not reach AIWorkPay.");
    }

    if (submission.status !== "pending" && submission.status !== "answered") {
      this.cb.recordFailure();
      return this.fallbackResult(question, `Unexpected status: ${submission.status}`);
    }

    // If already answered (fast path), return immediately
    if (submission.status === "answered" && submission.answer) {
      this.cb.recordSuccess();
      return this.buildResult(taskId, question, submission);
    }

    // Poll until answered or timeout
    const deadlineMs =
      Date.now() + CONSTITUTION.escalationPolicy.humanTimeoutSeconds * 1_000;

    logStep("DELEGATE", `Polling for task ${taskId} (timeout=${CONSTITUTION.escalationPolicy.humanTimeoutSeconds}s)`);

    while (Date.now() < deadlineMs) {
      await sleep(this.pollIntervalMs);
      let poll: DelegationResponse;
      try {
        poll = await this.client.pollTask(taskId);
      } catch (err) {
        this.cb.recordFailure();
        logStep("DELEGATE", `Poll error: ${(err as Error).message}`);
        break;
      }

      if (poll.status === "answered" && poll.answer) {
        this.cb.recordSuccess();
        logStep("DELEGATE", `Task ${taskId} answered by human`, { answer: poll.answer });
        return this.buildResult(taskId, question, poll);
      }
      if (poll.status === "rejected") {
        this.cb.recordFailure();
        return this.fallbackResult(question, "Human validator rejected the task.");
      }
      logStep("DELEGATE", `Task ${taskId} still pending…`);
    }

    // Timeout
    const policy = CONSTITUTION.escalationPolicy.fallbackOnTimeout;
    logStep("DELEGATE", `Task ${taskId} timed out (policy=${policy})`);
    return { ...this.fallbackResult(question, "Human validation timed out."), timedOut: true };
  }

  private buildResult(
    taskId: string,
    question: string,
    resp: DelegationResponse
  ): DelegationResult {
    return DelegationResultSchema.parse({
      taskId,
      question,
      answer: resp.answer ?? "No answer provided",
      validatedBy: resp.validatedBy ?? "unknown",
      resolvedAt: resp.resolvedAt ?? new Date().toISOString(),
      timedOut: false,
    });
  }

  private fallbackResult(question: string, reason: string): DelegationResult {
    return DelegationResultSchema.parse({
      taskId: uuidv4(),
      question,
      answer: reason,
      validatedBy: "fallback-system",
      resolvedAt: new Date().toISOString(),
      timedOut: false,
    });
  }
}

function DelegationRequest_safe(data: Omit<DelegationRequest, "callbackUrl">): DelegationRequest {
  return {
    ...data,
    timeoutSeconds: data.timeoutSeconds ?? 300,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
