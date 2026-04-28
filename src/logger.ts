import winston from "winston";
import path from "path";
import fs from "fs";

const LOG_DIR = path.resolve(process.cwd(), "logs");
const LOG_PATH = path.join(LOG_DIR, "agent_history.log");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

export const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
      return `[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${message}${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
          return `${level}: ${message}${metaStr}`;
        })
      ),
    }),
    new winston.transports.File({ filename: LOG_PATH }),
  ],
});

export function logStep(phase: "THINK" | "CRITICIZE" | "DECIDE" | "ACT" | "DELEGATE" | "RESUME" | "CORRECT", message: string, meta?: Record<string, unknown>): void {
  logger.info(`[${phase}] ${message}`, meta ?? {});
}
