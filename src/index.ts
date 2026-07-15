import "dotenv/config";
import path from "path";
import cors from "cors";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { migrate } from "./db/migrate";
import { closePool } from "./db/pool";
import { logger } from "./logger";
import { apiRouter } from "./routes";

const PORT = Number(process.env.PORT) || 3000;

const app = express();

app.set("trust proxy", 1);

app.use(
  helmet({
contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            "https://cdn.tailwindcss.com",
            "https://fonts.googleapis.com",
          ],
          scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        },
      },
  })
);

const corsOrigin = process.env.CORS_ORIGIN;
app.use(
  cors({
    origin: corsOrigin
      ? corsOrigin.split(",").map((o) => o.trim())
      : true,
  })
);

app.use(express.json({ limit: "16kb" }));

const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, please try again later" },
});
app.use(limiter);

app.use(apiRouter);

const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use((_req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

app.use(
  (err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("Unhandled error", { error: err.message, stack: err.stack });
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
);

async function start() {
  if (!process.env.DATABASE_URL) {
    logger.error("DATABASE_URL is not set");
    process.exit(1);
  }

  await migrate();

  const server = app.listen(PORT, "0.0.0.0", () => {
    logger.info(`Server listening on port ${PORT}`, {
      env: process.env.NODE_ENV ?? "development",
    });
  });

  const shutdown = async (signal: string) => {
    logger.info(`Shutting down (${signal})`);
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  logger.error("Failed to start", { error: String(err) });
  process.exit(1);
});
