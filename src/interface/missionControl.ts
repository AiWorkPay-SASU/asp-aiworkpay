import fs from "fs";
import path from "path";
import crypto from "crypto";
import { z } from "zod";
import { loadLongTermMemory, LongTermState } from "../memory/persistence";
import { logger, logStep } from "../logger";

// ── Signal file paths ─────────────────────────────────────────────────────────
const SIGNALS_DIR = path.resolve(process.cwd(), "signals");
const EMERGENCY_SIGNAL_PATH = path.join(SIGNALS_DIR, "EMERGENCY_STOP.signal");
const ALERTS_LOG_PATH = path.join(SIGNALS_DIR, "ALERTS.jsonl");
const SAFE_MODE_STATE_PATH = path.join(SIGNALS_DIR, "SAFE_MODE_STATE.json");

// Ensure signals directory exists on module load
if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });

// ── Alert schema ──────────────────────────────────────────────────────────────
export const AlertSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(["FINANCIAL", "CONSTITUTIONAL", "CRITICAL", "SAFE_MODE"]),
  severity: z.enum(["WARNING", "CRITICAL", "FATAL"]),
  message: z.string(),
  agentId: z.string(),
  actionType: z.string(),
  estimatedCostUSD: z.number().nonnegative(),
  timestamp: z.string().datetime(),
  acknowledged: z.boolean().default(false),
});
export type Alert = z.infer<typeof AlertSchema>;

// ── Safe Mode state schema ────────────────────────────────────────────────────
const SafeModeStateSchema = z.object({
  activatedAt: z.string().datetime(),
  reason: z.string(),
  lastIteration: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
});
type SafeModeState = z.infer<typeof SafeModeStateSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// 1. DAILY EXECUTIVE SUMMARY
// ═════════════════════════════════════════════════════════════════════════════

export function generateDailySummary(): string {
  const mem: LongTermState = loadLongTermMemory();
  const { globalState, lessons, delegationHistory } = mem;
  const now = new Date();

  const recentLessons = [...lessons]
    .sort((a, b) => new Date(b.learnedAt).getTime() - new Date(a.learnedAt).getTime())
    .slice(0, 5);

  const recentDelegations = [...delegationHistory]
    .sort((a, b) => new Date(b.resolvedAt).getTime() - new Date(a.resolvedAt).getTime())
    .slice(0, 3);

  const alertCount = countAlerts();
  const safeMode = isEmergencyStopActive();
  const avgConfidence =
    lessons.length > 0
      ? (lessons.reduce((sum, l) => sum + l.confidence, 0) / lessons.length).toFixed(3)
      : "N/A";

  const humanLessons = lessons.filter((l) => l.source === "human").length;
  const selfLessons = lessons.filter((l) => l.source === "self").length;

  const lines: string[] = [
    "╔══════════════════════════════════════════════════════════════╗",
    "║           ASP DAILY EXECUTIVE SUMMARY — TL;DR               ║",
    "╚══════════════════════════════════════════════════════════════╝",
    `  Date         : ${now.toISOString().replace("T", " ").slice(0, 19)} UTC`,
    `  Status       : ${safeMode ? "🔴 SAFE MODE ACTIVE" : "🟢 OPERATIONAL"}`,
    "",
    "── GLOBAL COUNTERS ─────────────────────────────────────────────",
    `  Sessions run         : ${globalState.sessionCount}`,
    `  Total iterations     : ${globalState.totalIterations}`,
    `  Human delegations    : ${globalState.totalDelegations}`,
    `  Self-corrections     : ${globalState.totalCorrections}`,
    `  Unacknowledged alerts: ${alertCount}`,
    "",
    "── KNOWLEDGE BASE ──────────────────────────────────────────────",
    `  Total lessons stored : ${lessons.length}`,
    `    ↳ From humans      : ${humanLessons}`,
    `    ↳ Self-learned     : ${selfLessons}`,
    `  Avg lesson confidence: ${avgConfidence}`,
    "",
    "── RECENT LESSONS (last 5) ──────────────────────────────────────",
  ];

  if (recentLessons.length === 0) {
    lines.push("  (none yet)");
  } else {
    recentLessons.forEach((l, i) => {
      lines.push(`  ${i + 1}. [${l.source.toUpperCase()} · ${(l.confidence * 100).toFixed(0)}%] "${l.question}"`);
      lines.push(`     → ${l.answer.slice(0, 120)}${l.answer.length > 120 ? "…" : ""}`);
    });
  }

  lines.push("");
  lines.push("── RECENT HUMAN ESCALATIONS (last 3) ────────────────────────");

  if (recentDelegations.length === 0) {
    lines.push("  (none yet)");
  } else {
    recentDelegations.forEach((d, i) => {
      const ts = new Date(d.resolvedAt).toISOString().slice(0, 16).replace("T", " ");
      lines.push(`  ${i + 1}. [${ts}] "${d.question}"`);
      lines.push(`     ✓ Human answered: "${d.humanResponse.slice(0, 100)}${d.humanResponse.length > 100 ? "…" : ""}"`);
    });
  }

  lines.push("");
  lines.push("── RECENT ALERTS ───────────────────────────────────────────────");
  const lastAlerts = readLastAlerts(3);
  if (lastAlerts.length === 0) {
    lines.push("  (none)");
  } else {
    lastAlerts.forEach((a) => {
      lines.push(`  ⚠  [${a.severity}] ${a.message} (cost: $${a.estimatedCostUSD.toFixed(2)})`);
    });
  }

  lines.push("");
  lines.push("── RECOMMENDATION ──────────────────────────────────────────────");
  if (safeMode) {
    lines.push("  ⛔ Safe Mode is active. Run `npm run resume` to restart the agent.");
  } else if (alertCount > 0) {
    lines.push(`  ⚠  ${alertCount} unacknowledged alert(s). Review signals/ALERTS.jsonl.`);
  } else if (globalState.totalIterations === 0) {
    lines.push("  ℹ  Agent has not run yet. Execute `npm start` to begin.");
  } else {
    lines.push("  ✅ System operating normally. No action required.");
  }

  lines.push("════════════════════════════════════════════════════════════════");

  const summary = lines.join("\n");
  logger.info("[MISSION CONTROL] Daily summary generated");
  return summary;
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. EMERGENCY OVERRIDE
// ═════════════════════════════════════════════════════════════════════════════

export function emergencyOverride(
  reason = "Manual override by human operator",
  sessionId = "unknown",
  lastIteration = 0
): void {
  // Write the stop signal
  const signalPayload = JSON.stringify({ triggeredAt: new Date().toISOString(), reason });
  fs.writeFileSync(EMERGENCY_SIGNAL_PATH, signalPayload, "utf-8");

  // Persist safe-mode context so the agent knows why it stopped
  const safeModeState: SafeModeState = SafeModeStateSchema.parse({
    activatedAt: new Date().toISOString(),
    reason,
    lastIteration,
    sessionId,
  });
  fs.writeFileSync(SAFE_MODE_STATE_PATH, JSON.stringify(safeModeState, null, 2), "utf-8");

  // Fire a SAFE_MODE alert for audit trail
  sendAlert({
    id: crypto.randomUUID(),
    type: "SAFE_MODE",
    severity: "FATAL",
    message: `EMERGENCY OVERRIDE ACTIVATED — ${reason}`,
    agentId: sessionId,
    actionType: "EMERGENCY_STOP",
    estimatedCostUSD: 0,
    timestamp: new Date().toISOString(),
    acknowledged: false,
  });

  logger.error(
    "╔══════════════════════════════════════════════════════════════╗\n" +
    "║  🔴  EMERGENCY OVERRIDE — AGENT ENTERING SAFE MODE  🔴      ║\n" +
    "╚══════════════════════════════════════════════════════════════╝"
  );
  logger.error(`  Reason   : ${reason}`);
  logger.error(`  Signal   : ${EMERGENCY_SIGNAL_PATH}`);
  logger.error("  The agent will stop at the end of the current tick.");
}

export function clearEmergencyStop(): void {
  if (fs.existsSync(EMERGENCY_SIGNAL_PATH)) {
    fs.unlinkSync(EMERGENCY_SIGNAL_PATH);
    logger.info("[MISSION CONTROL] Emergency stop signal cleared — agent may resume.");
  }
  if (fs.existsSync(SAFE_MODE_STATE_PATH)) {
    fs.unlinkSync(SAFE_MODE_STATE_PATH);
  }
}

export function isEmergencyStopActive(): boolean {
  return fs.existsSync(EMERGENCY_SIGNAL_PATH);
}

export function getSafeModeState(): SafeModeState | null {
  if (!fs.existsSync(SAFE_MODE_STATE_PATH)) return null;
  try {
    return SafeModeStateSchema.parse(JSON.parse(fs.readFileSync(SAFE_MODE_STATE_PATH, "utf-8")));
  } catch {
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. FINANCIAL ALERT
// ═════════════════════════════════════════════════════════════════════════════

export function sendAlert(alert: Alert): void {
  AlertSchema.parse(alert);

  // Append to JSONL log (one JSON object per line)
  const line = JSON.stringify(alert) + "\n";
  fs.appendFileSync(ALERTS_LOG_PATH, line, "utf-8");

  const prefix =
    alert.severity === "FATAL"
      ? "🔴 FATAL"
      : alert.severity === "CRITICAL"
      ? "🟠 CRITICAL"
      : "🟡 WARNING";

  logger.warn(
    `\n┌─────────────────────────────────────────────────────────────┐\n` +
    `│ ${prefix} ALERT — ${alert.type.padEnd(20)}                   │\n` +
    `│  ${alert.message.slice(0, 60).padEnd(60)} │\n` +
    `│  Cost: $${alert.estimatedCostUSD.toFixed(2).padStart(8)}   Agent: ${alert.agentId.slice(0, 20).padEnd(20)} │\n` +
    `└─────────────────────────────────────────────────────────────┘`
  );

  // Optional webhook (set ALERT_WEBHOOK_URL in .env)
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (webhookUrl) {
    import("axios").then(({ default: axios }) => {
      axios.post(webhookUrl, alert, { timeout: 5_000 }).catch((err) => {
        logger.error(`[MISSION CONTROL] Webhook delivery failed: ${(err as Error).message}`);
      });
    });
  }
}

export function checkFinancialCost(
  estimatedCostUSD: number,
  thresholdUSD: number,
  agentId: string,
  actionType: string
): boolean {
  if (estimatedCostUSD > thresholdUSD) {
    sendAlert({
      id: crypto.randomUUID(),
      type: "FINANCIAL",
      severity: estimatedCostUSD > thresholdUSD * 2 ? "FATAL" : "CRITICAL",
      message: `Action "${actionType}" exceeds financial threshold ($${estimatedCostUSD.toFixed(2)} > $${thresholdUSD})`,
      agentId,
      actionType,
      estimatedCostUSD,
      timestamp: new Date().toISOString(),
      acknowledged: false,
    });
    return true; // alert was fired
  }
  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function countAlerts(): number {
  if (!fs.existsSync(ALERTS_LOG_PATH)) return 0;
  return fs
    .readFileSync(ALERTS_LOG_PATH, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line) as Alert; } catch { return null; } })
    .filter((a): a is Alert => a !== null && !a.acknowledged)
    .length;
}

function readLastAlerts(n: number): Alert[] {
  if (!fs.existsSync(ALERTS_LOG_PATH)) return [];
  return fs
    .readFileSync(ALERTS_LOG_PATH, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line) as Alert; } catch { return null; } })
    .filter((a): a is Alert => a !== null)
    .slice(-n);
}

// ═════════════════════════════════════════════════════════════════════════════
// CLI entry point:  ts-node src/interface/missionControl.ts [summary|stop|resume]
// ═════════════════════════════════════════════════════════════════════════════
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === "summary") {
    console.log(generateDailySummary());
  } else if (cmd === "stop") {
    emergencyOverride(process.argv[3] ?? "Manual stop from CLI");
    console.log("✅ Emergency stop signal written. Agent will halt at next tick.");
  } else if (cmd === "resume") {
    clearEmergencyStop();
    console.log("✅ Emergency stop cleared. You can restart the agent.");
  } else {
    console.log("Usage: ts-node src/interface/missionControl.ts [summary|stop|resume]");
  }
}
