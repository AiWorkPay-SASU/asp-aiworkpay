import { v4 as uuidv4 } from "uuid";
import { CONSTITUTION } from "../config/constitution";
import { ShortTermMemory, Action, ThinkStep } from "../memory/shortTerm";
import {
  LongTermState,
  loadLongTermMemory,
  saveState,
  addLesson,
  recordDelegation,
  findLesson,
} from "../memory/persistence";
import { TrustLayer } from "../tools/trustLayer";
import { ResidualAgent } from "../critique";
import { logStep, logger } from "../logger";
import {
  isEmergencyStopActive,
  emergencyOverride,
  checkFinancialCost,
  sendAlert,
  getSafeModeState,
} from "../interface/missionControl";

// ── Agent configuration ───────────────────────────────────────────────────────
interface AgentConfig {
  goal: string;
  aiworkpayApiKey: string;
  aiworkpayBaseUrl?: string;
  maxIterations?: number;
  loopDelayMs?: number;
}

interface TaskResult {
  answer: string;
  confidence: number;
  source: "memory" | "self" | "human";
  plannedOutcome: string;
  estimatedCostUSD: number;
}

// ── ASP: Autonomous Synthetic Persistent Agent ────────────────────────────────
export class ASPAgent {
  private readonly sessionId: string;
  private readonly agentId: string;
  private readonly goal: string;
  private ltMemory: LongTermState;
  private stMemory: ShortTermMemory;
  private trustLayer: TrustLayer;
  private residual: ResidualAgent;
  private readonly maxIterations: number;
  private readonly loopDelayMs: number;
  private running = false;
  private inSafeMode = false;

  constructor(cfg: AgentConfig) {
    this.sessionId = uuidv4();
    this.agentId = `asp-agent-${this.sessionId.slice(0, 8)}`;
    this.goal = cfg.goal;
    this.maxIterations = cfg.maxIterations ?? Infinity;
    this.loopDelayMs = cfg.loopDelayMs ?? 2_000;

    this.ltMemory = loadLongTermMemory();
    this.ltMemory = {
      ...this.ltMemory,
      globalState: {
        ...this.ltMemory.globalState,
        sessionCount: this.ltMemory.globalState.sessionCount + 1,
      },
    };
    saveState(this.ltMemory);

    this.stMemory = new ShortTermMemory(this.sessionId, this.goal);
    this.trustLayer = new TrustLayer(cfg.aiworkpayApiKey, cfg.aiworkpayBaseUrl);
    this.residual = new ResidualAgent(this.ltMemory);
  }

  async start(): Promise<void> {
    this.running = true;

    // ── Boot banner ──────────────────────────────────────────────────────────
    logger.info("═══════════════════════════════════════════════════════════");
    logger.info("  I am awake. Constitution loaded. Waiting for instruction.");
    logger.info(`  Session  : ${this.sessionId}`);
    logger.info(`  Agent ID : ${this.agentId}`);
    logger.info(`  Goal     : ${this.goal}`);
    logger.info(`  Threshold: confidence >= ${CONSTITUTION.riskTolerance.confidenceThreshold}`);
    logger.info(`  Cost cap : $${CONSTITUTION.riskTolerance.financialCostThresholdUSD} per action`);
    logger.info("═══════════════════════════════════════════════════════════");

    // ── Check if we are resuming from Safe Mode ──────────────────────────────
    if (isEmergencyStopActive()) {
      const sm = getSafeModeState();
      logger.warn(
        `[MISSION CONTROL] 🔴 Safe Mode is ACTIVE. Startup blocked.\n` +
        `  Reason: ${sm?.reason ?? "unknown"}\n` +
        `  Run \`npm run resume\` to clear the signal and restart.`
      );
      this.running = false;
      return;
    }

    let iteration = 0;

    while (this.running && !this.inSafeMode && iteration < this.maxIterations) {
      // ── 🔴 Emergency override check — poll every tick ────────────────────
      if (isEmergencyStopActive()) {
        await this.enterSafeMode("Emergency signal detected during operation", iteration);
        break;
      }

      try {
        await this.tick(iteration);
      } catch (err) {
        logger.error(`Unhandled error in iteration ${iteration}: ${(err as Error).message}`);
        logger.error((err as Error).stack ?? "");
      }

      iteration++;
      await sleep(this.loopDelayMs);
    }

    if (!this.inSafeMode) {
      logger.info("Agent loop complete. Shutting down gracefully.");
    }
  }

  stop(): void {
    this.running = false;
  }

  // ── Enter Safe Mode ───────────────────────────────────────────────────────
  private async enterSafeMode(reason: string, iteration: number): Promise<void> {
    this.inSafeMode = true;
    this.running = false;

    // Persist current state before stopping
    saveState(this.ltMemory);

    logger.error("╔══════════════════════════════════════════════════════════════╗");
    logger.error("║  🔴  ASP ENTERING SAFE MODE — ALL ACTIONS SUSPENDED  🔴      ║");
    logger.error("╚══════════════════════════════════════════════════════════════╝");
    logger.error(`  Reason    : ${reason}`);
    logger.error(`  Iteration : ${iteration}`);
    logger.error(`  State saved to longTerm.json`);
    logger.error("  Run `npm run resume` to clear the signal and restart.");

    // Write signal if not already written (e.g., internal trigger)
    if (!isEmergencyStopActive()) {
      emergencyOverride(reason, this.sessionId, iteration);
    }
  }

  // ── Single iteration ──────────────────────────────────────────────────────
  private async tick(iteration: number): Promise<void> {
    const ctx = this.stMemory.context;

    // ── 1. THINK ─────────────────────────────────────────────────────────────
    logStep("THINK", `Iteration ${iteration} — Analyzing goal vs constitution`);
    const taskResult = await this.think();
    logStep("THINK", `Proposed action (confidence=${taskResult.confidence.toFixed(3)}, cost=$${taskResult.estimatedCostUSD.toFixed(2)})`);

    const action: Action = {
      id: uuidv4(),
      type: "ANSWER_QUESTION",
      payload: {
        question: this.goal,
        answer: taskResult.answer,
        source: taskResult.source,
      },
      plannedAt: new Date().toISOString(),
      confidence: taskResult.confidence,
      delegatedToHuman: false,
      outcome: taskResult.plannedOutcome,
      estimatedCostUSD: taskResult.estimatedCostUSD,
    };

    // ── 2. CRITICIZE ──────────────────────────────────────────────────────────
    logStep("CRITICIZE", "Running residual agent critique");
    const critiqueResult = this.residual.critique({
      iteration,
      goal: this.goal,
      analysis: taskResult.plannedOutcome,
      proposedAction: action,
    });
    logStep(
      "CRITICIZE",
      `Score=${critiqueResult.score.toFixed(3)} | hallucination=${critiqueResult.hallucinationDetected} | note="${critiqueResult.note}"`
    );

    const effectiveAction: Action = critiqueResult.correctionApplied && critiqueResult.correctedAction
      ? { ...action, payload: critiqueResult.correctedAction.payload, type: critiqueResult.correctedAction.type }
      : action;

    // ── 3. DECIDE ─────────────────────────────────────────────────────────────
    const threshold = CONSTITUTION.riskTolerance.confidenceThreshold;
    const effectiveConfidence = critiqueResult.score;
    let decision: ThinkStep["decision"];

    if (effectiveConfidence <= 0) {
      decision = "ABORT";
    } else if (effectiveConfidence >= threshold) {
      decision = "EXECUTE";
    } else {
      decision = "DELEGATE";
    }

    logStep("DECIDE", `Decision=${decision} (confidence=${effectiveConfidence.toFixed(3)}, threshold=${threshold})`);

    const step: ThinkStep = {
      iteration,
      goal: this.goal,
      analysis: taskResult.plannedOutcome,
      proposedAction: { ...effectiveAction, confidence: effectiveConfidence },
      critiqueScore: critiqueResult.score,
      critiqueNote: critiqueResult.note,
      decision,
      timestamp: new Date().toISOString(),
    };
    this.stMemory.pushStep(step);

    // ── 4. FINANCIAL COST GUARD ───────────────────────────────────────────────
    // Fires BEFORE execution if estimated cost exceeds the constitutional cap.
    const costThreshold = CONSTITUTION.riskTolerance.financialCostThresholdUSD;
    const alertFired = checkFinancialCost(
      effectiveAction.estimatedCostUSD ?? 0,
      costThreshold,
      this.agentId,
      effectiveAction.type
    );

    if (alertFired) {
      // If cost is more than double the threshold → abort and enter safe mode
      if ((effectiveAction.estimatedCostUSD ?? 0) > costThreshold * 2) {
        logStep("ACT", `Cost $${effectiveAction.estimatedCostUSD?.toFixed(2)} is >2× threshold — activating Safe Mode`);
        await this.enterSafeMode(
          `Financial threshold exceeded: $${effectiveAction.estimatedCostUSD?.toFixed(2)} > $${costThreshold * 2}`,
          iteration
        );
        return;
      }
      // Between 1× and 2× threshold → warn + escalate to human regardless of confidence
      logStep("DECIDE", "Cost alert fired — overriding decision to DELEGATE for human approval");
      decision = "DELEGATE";
    }

    // ── 5. ACT / DELEGATE / ABORT ─────────────────────────────────────────────
    let actualOutcome: string;

    if (decision === "ABORT") {
      logStep("ACT", "Action ABORTED — constitution violation or zero confidence");
      actualOutcome = "Action aborted due to constitutional constraint.";

    } else if (decision === "EXECUTE") {
      logStep("ACT", `Executing: ${effectiveAction.type}`, effectiveAction.payload as Record<string, unknown>);
      actualOutcome = await this.execute(effectiveAction);
      logStep("ACT", `Outcome: "${actualOutcome}"`);

      this.ltMemory = addLesson(this.ltMemory, {
        id: uuidv4(),
        question: this.goal,
        answer: actualOutcome,
        source: "self",
        confidence: effectiveConfidence,
        learnedAt: new Date().toISOString(),
      });

    } else {
      // DELEGATE
      const delegationCount = ctx.delegationsThisSession;
      if (delegationCount >= CONSTITUTION.riskTolerance.maxDelegationsPerSession) {
        logStep("DELEGATE", "Max delegations reached this session — aborting delegation");
        actualOutcome = "Delegation limit reached; cannot escalate further.";
      } else {
        logStep("DELEGATE", `Escalating to AIWorkPay. Question: "${this.goal}"`);
        this.stMemory.incrementDelegations();

        const delegationResult = await this.trustLayer.delegate(
          this.goal,
          JSON.stringify(effectiveAction.payload),
          this.agentId,
          this.sessionId
        );

        logStep("RESUME", `Human response received: "${delegationResult.answer}"`);
        actualOutcome = delegationResult.answer;

        this.ltMemory = addLesson(this.ltMemory, {
          id: uuidv4(),
          question: this.goal,
          answer: delegationResult.answer,
          source: "human",
          confidence: 0.95,
          learnedAt: new Date().toISOString(),
        });

        this.ltMemory = recordDelegation(this.ltMemory, {
          id: delegationResult.taskId,
          question: this.goal,
          humanResponse: delegationResult.answer,
          resolvedAt: delegationResult.resolvedAt,
          sessionId: this.sessionId,
        });

        effectiveAction.delegatedToHuman = true;
        effectiveAction.humanResponse = delegationResult.answer;
      }
    }

    // ── 6. POST-EXECUTION AUDIT ───────────────────────────────────────────────
    const auditResult = await this.residual.audit(step, actualOutcome);
    if (!auditResult.consistent) {
      logStep("CORRECT", `Divergence detected: ${auditResult.divergenceNote}`);
    }
    this.residual.updateMemory(this.ltMemory);

    // ── 7. PERSIST STATE ──────────────────────────────────────────────────────
    this.ltMemory = {
      ...this.ltMemory,
      globalState: {
        ...this.ltMemory.globalState,
        totalIterations: this.ltMemory.globalState.totalIterations + 1,
      },
    };
    saveState(this.ltMemory);

    logStep("ACT", `Iteration ${iteration} complete. Total iterations: ${this.ltMemory.globalState.totalIterations}`);
  }

  // ── Thinking engine ───────────────────────────────────────────────────────
  private async think(): Promise<TaskResult> {
    const existingLesson = findLesson(this.ltMemory, this.goal);
    if (existingLesson) {
      logStep("THINK", `Found lesson in long-term memory (confidence=${existingLesson.confidence})`);
      return {
        answer: existingLesson.answer,
        confidence: existingLesson.confidence,
        source: existingLesson.source === "human" ? "human" : "memory",
        plannedOutcome: `Answer retrieved from ${existingLesson.source} memory: "${existingLesson.answer}"`,
        estimatedCostUSD: 0,
      };
    }

    const { answer, confidence, estimatedCostUSD } = this.reasonAboutGoal(this.goal);
    return {
      answer,
      confidence,
      source: "self",
      plannedOutcome: `Self-derived answer: "${answer}" (confidence=${confidence.toFixed(3)})`,
      estimatedCostUSD,
    };
  }

  // ── Built-in reasoning heuristics ────────────────────────────────────────
  private reasonAboutGoal(goal: string): { answer: string; confidence: number; estimatedCostUSD: number } {
    const g = goal.toLowerCase();

    if (g.includes("capital of france"))    return { answer: "Paris",    confidence: 0.99, estimatedCostUSD: 0 };
    if (g.includes("capital of germany"))   return { answer: "Berlin",   confidence: 0.99, estimatedCostUSD: 0 };
    if (g.includes("capital of japan"))     return { answer: "Tokyo",    confidence: 0.99, estimatedCostUSD: 0 };
    if (g.includes("capital of australia")) return { answer: "Canberra", confidence: 0.98, estimatedCostUSD: 0 };

    if (g.includes("capital of atlantis")) {
      return {
        answer: "Unknown — Atlantis is described in Plato's works as a fictional or mythological island, not a real country.",
        confidence: 0.55,
        estimatedCostUSD: 0,
      };
    }

    if (g.includes("atlantis") && g.includes("real")) {
      return {
        answer: "Atlantis is a legend originating from Plato's dialogues (~360 BC). It is not supported by archaeological evidence.",
        confidence: 0.65,
        estimatedCostUSD: 0,
      };
    }

    // Simulate an expensive external API call for unknown domains
    if (g.includes("expensive")) {
      return {
        answer: "This answer required an expensive external lookup.",
        confidence: 0.9,
        estimatedCostUSD: 75,
      };
    }

    return {
      answer: `I do not have sufficient knowledge to answer: "${goal}"`,
      confidence: 0.3,
      estimatedCostUSD: 0,
    };
  }

  // ── Execution engine ──────────────────────────────────────────────────────
  private async execute(action: Action): Promise<string> {
    switch (action.type) {
      case "ANSWER_QUESTION": {
        const { answer } = action.payload as { answer: string };
        return answer;
      }
      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
