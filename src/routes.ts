import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import {
  loginAdmin,
  logoutAdmin,
  requireAdmin,
  setSessionCookie,
  type AdminRequest,
} from "./auth";
import {
  createEntry,
  getEntryByAngelName,
  getEntryById,
  getEntryByRealName,
  listEntries,
  listEntriesForAdmin,
  listPending,
  touchEntryEmail,
  updateEntryStatus,
} from "./db/entries";
import { graphicCodeExists, listActiveGraphics } from "./db/graphics";
import { logger } from "./logger";
import {
  adminLoginSchema,
  statusSchema,
  submitSchema,
  uuidSchema,
} from "./validation";

export const apiRouter = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many login attempts, try again later" },
});

/** POST /admin/login */
apiRouter.post(
  "/admin/login",
  loginLimiter,
  asyncHandler(async (req, res) => {
    const parsed = adminLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const result = await loginAdmin(parsed.data.email, parsed.data.password);
    if (!result) {
      res.status(401).json({ success: false, error: "Invalid email or password" });
      return;
    }

    setSessionCookie(res, result.token);
    logger.info("Admin logged in", { email: result.admin.email });
    res.json({ success: true, admin: result.admin });
  })
);

/** POST /admin/logout */
apiRouter.post(
  "/admin/logout",
  asyncHandler(async (req, res) => {
    await logoutAdmin(req, res);
    res.json({ success: true });
  })
);

/** GET /admin/me — current session */
apiRouter.get(
  "/admin/me",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    res.json({ success: true, admin: req.admin });
  })
);

/** GET /admin/entries — angel names + graphics for dashboard */
apiRouter.get(
  "/admin/entries",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const entries = await listEntriesForAdmin(500);
    res.json({ success: true, count: entries.length, entries });
  })
);

/** PATCH /admin/entries/:id/complete — mark pending/processing as processed */
apiRouter.patch(
  "/admin/entries/:id/complete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid entry ID" });
      return;
    }

    const existing = await getEntryById(idCheck.data);
    if (!existing) {
      res.status(404).json({ success: false, error: "Entry not found" });
      return;
    }

    if (existing.status === "processed") {
      res.json({ success: true, entry: existing });
      return;
    }

    const entry = await updateEntryStatus(idCheck.data, "processed");
    if (!entry) {
      res.status(404).json({ success: false, error: "Entry not found" });
      return;
    }

    logger.info("Admin marked entry complete", { id: entry.id });
    res.json({ success: true, entry });
  })
);

/** GET /graphics — active dropdown options (codes + labels from DB) */
apiRouter.get(
  "/graphics",
  asyncHandler(async (_req, res) => {
    const graphics = await listActiveGraphics();
    res.json({ success: true, count: graphics.length, graphics });
  })
);

/** POST /submit — save request with email + chosen graphic */
apiRouter.post(
  "/submit",
  asyncHandler(async (req, res) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { real_name, angel_name, email, graphic_code, metadata } =
      parsed.data;

    const validCode = await graphicCodeExists(graphic_code);
    if (!validCode) {
      res.status(400).json({
        success: false,
        error: "Unknown or inactive graphic code",
        details: { graphic_code: ["Select a valid graphic from the list"] },
      });
      return;
    }

    const existing = await getEntryByAngelName(angel_name);
    if (existing) {
      const entry =
        (await touchEntryEmail(existing.id, email)) ?? existing;

      logger.info("Duplicate angel name submit", {
        id: entry.id,
        angel_name: entry.angel_name,
      });

      res.status(200).json({
        success: true,
        duplicate: true,
        message:
          "That angel name is already in our database. We'll send you an update soon — please check your email.",
        entry,
      });
      return;
    }

    const entry = await createEntry({
      real_name,
      angel_name,
      email,
      graphic_code,
      metadata,
    });

    logger.info("Entry created", {
      id: entry.id,
      angel_name: entry.angel_name,
      graphic_code: entry.graphic_code,
      status: entry.status,
    });

    res.status(201).json({
      success: true,
      duplicate: false,
      message: "Request saved. You’re on the list.",
      entry,
    });
  })
);

/** GET /entries — list recent entries (monitoring / debug) */
apiRouter.get(
  "/entries",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const entries = await listEntries(limit, offset);
    res.json({ success: true, count: entries.length, entries });
  })
);

/**
 * GET /pending — automation poll endpoint
 * Returns unprocessed entries oldest-first so photo generation can drain the queue.
 */
apiRouter.get(
  "/pending",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const entries = await listPending(limit);
    res.json({ success: true, count: entries.length, entries });
  })
);

/** GET /entry/:id — fetch by UUID */
apiRouter.get(
  "/entry/:id",
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid entry ID" });
      return;
    }

    const entry = await getEntryById(idCheck.data);
    if (!entry) {
      res.status(404).json({ success: false, error: "Entry not found" });
      return;
    }

    res.json({ success: true, entry });
  })
);

/**
 * GET /lookup — query by angel_name or real_name
 * Examples: /lookup?angel_name=Gabriel  /lookup?real_name=Alex
 */
apiRouter.get(
  "/lookup",
  asyncHandler(async (req, res) => {
    const angelName =
      typeof req.query.angel_name === "string" ? req.query.angel_name.trim() : "";
    const realName =
      typeof req.query.real_name === "string" ? req.query.real_name.trim() : "";

    if (!angelName && !realName) {
      res.status(400).json({
        success: false,
        error: "Provide angel_name or real_name query parameter",
      });
      return;
    }

    const entry = angelName
      ? await getEntryByAngelName(angelName)
      : await getEntryByRealName(realName);

    if (!entry) {
      res.status(404).json({ success: false, error: "Entry not found" });
      return;
    }

    res.json({ success: true, entry });
  })
);

/**
 * PATCH /entry/:id/status — mark processed / failed (for automation scripts)
 */
apiRouter.patch(
  "/entry/:id/status",
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid entry ID" });
      return;
    }

    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const entry = await updateEntryStatus(
      idCheck.data,
      parsed.data.status,
      parsed.data.metadata
    );

    if (!entry) {
      res.status(404).json({ success: false, error: "Entry not found" });
      return;
    }

    logger.info("Entry status updated", {
      id: entry.id,
      status: entry.status,
    });

    res.json({ success: true, entry });
  })
);

/** GET /health — liveness for Railway */
apiRouter.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});
