import "dotenv/config";
import { ASPAgent } from "./src/core/agent";

const GOAL = process.env.AGENT_GOAL ?? "What is the capital of Atlantis?";
const API_KEY = process.env.AIWORKPAY_API_KEY ?? "stub-key";
const BASE_URL = process.env.AIWORKPAY_BASE_URL;
const MAX_ITERATIONS = parseInt(process.env.MAX_ITERATIONS ?? "3", 10);

async function main(): Promise<void> {
  const agent = new ASPAgent({
    goal: GOAL,
    aiworkpayApiKey: API_KEY,
    aiworkpayBaseUrl: BASE_URL,
    maxIterations: MAX_ITERATIONS,
    loopDelayMs: 1_000,
  });

  // Graceful shutdown on SIGINT / SIGTERM
  const shutdown = (): void => {
    console.log("\nShutdown signal received. Stopping agent…");
    agent.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await agent.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
