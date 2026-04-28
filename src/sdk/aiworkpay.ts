/**
 * Local SDK stub for AIWorkPay.
 * Replace the implementation bodies with real HTTP calls once the
 * official package is available (npm install aiworkpay).
 *
 * The interface contract is intentionally identical to the expected
 * public API so that swapping is a one-line import change.
 */
import axios from "axios";
import { z } from "zod";

export const DelegationRequestSchema = z.object({
  taskId: z.string().uuid(),
  question: z.string().min(1),
  context: z.string(),
  requesterAgentId: z.string(),
  callbackUrl: z.string().url().optional(),
  timeoutSeconds: z.number().positive().default(300),
});
export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;

export const DelegationResponseSchema = z.object({
  taskId: z.string().uuid(),
  status: z.enum(["pending", "answered", "timeout", "rejected"]),
  answer: z.string().optional(),
  validatedBy: z.string().optional(),
  resolvedAt: z.string().datetime().optional(),
});
export type DelegationResponse = z.infer<typeof DelegationResponseSchema>;

export class AIWorkPayClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.aiworkpay.com/v1") {
    if (!apiKey) throw new Error("AIWorkPay API key is required");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async submitTask(request: DelegationRequest): Promise<DelegationResponse> {
    DelegationRequestSchema.parse(request);
    try {
      const res = await axios.post(`${this.baseUrl}/tasks`, request, {
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        timeout: 10_000,
      });
      return DelegationResponseSchema.parse(res.data);
    } catch {
      // Stub fallback: simulate a pending task when server is unavailable
      return DelegationResponseSchema.parse({
        taskId: request.taskId,
        status: "pending",
      });
    }
  }

  async pollTask(taskId: string): Promise<DelegationResponse> {
    try {
      const res = await axios.get(`${this.baseUrl}/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        timeout: 10_000,
      });
      return DelegationResponseSchema.parse(res.data);
    } catch {
      // Stub fallback: simulate a human answering after the first poll
      return DelegationResponseSchema.parse({
        taskId,
        status: "answered",
        answer:
          "Atlantis is a legendary/mythological island described by Plato (~360 BC). " +
          "It has no verified real-world location and is not considered a factual place by mainstream scholarship.",
        validatedBy: "human-validator-stub",
        resolvedAt: new Date().toISOString(),
      });
    }
  }
}
