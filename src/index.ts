import "dotenv/config";
import path from "path";
import cors from "cors";
import cookieParser from "cookie-parser";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import helmet from "helmet";
import { migrate } from "./db/migrate";
import { closePool } from "./db/pool";
import { logger } from "./logger";
import { apiRouter } from "./routes";
import { globalLimiter } from "./security";

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
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.tailwindcss.com",
          "https://cdn.jsdelivr.net",
          "https://unpkg.com",
        ],
        scriptSrcElem: [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.tailwindcss.com",
          "https://cdn.jsdelivr.net",
          "https://unpkg.com",
        ],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: [
          "'self'",
          "https://cdn.jsdelivr.net",
          "https://unpkg.com",
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        workerSrc: ["'self'", "blob:"],
        childSrc: ["'self'", "blob:"],
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

app.use(express.json({ limit: "8kb" }));
app.use(express.urlencoded({ extended: false, limit: "8kb" }));
app.use(cookieParser());

app.use(globalLimiter);

// Basic abuse headers
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

app.use(apiRouter);

const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/admin", (_req, res) => {
  res.redirect(302, "/admin/");
});

app.get("/admin/", (_req, res) => {
  res.sendFile(path.join(publicDir, "admin", "index.html"));
});

app.get("/admin/login", (_req, res) => {
  res.sendFile(path.join(publicDir, "admin", "login.html"));
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
