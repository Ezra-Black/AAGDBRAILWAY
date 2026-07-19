import { z } from "zod";

/** Strip control chars / zero-width junk that can be used in abuse payloads. */
function sanitizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

const nameField = z
  .string()
  .transform(sanitizeText)
  .pipe(
    z
      .string()
      .min(1, "Required")
      .max(120, "Must be 120 characters or fewer")
      .refine((v) => !/[<>{};`$\\]/.test(v), "Contains invalid characters")
      .refine((v) => !/(--|;|\/\*|\*\/)/.test(v), "Contains invalid characters")
  );

const emailField = z
  .string()
  .transform(sanitizeText)
  .pipe(
    z
      .string()
      .min(1, "Email is required")
      .max(254, "Email is too long")
      .email("Enter a valid email")
      .refine((v) => !/[<>{};`]/.test(v), "Contains invalid characters")
  );

const graphicCodeField = z
  .string()
  .transform(sanitizeText)
  .pipe(
    z
      .string()
      .min(1, "Choose a graphic")
      .max(64, "Invalid graphic code")
      .refine((v) => !/[<>{};`$\\]/.test(v), "Invalid graphic code")
  );

/** Public submit — strict object, no extra fields (incl. no free-form metadata). */
export const submitSchema = z
  .object({
    real_name: nameField,
    angel_name: nameField,
    email: emailField,
    graphic_code: graphicCodeField,
    // Honeypot — must be empty/omitted (bots that fill it are caught earlier).
    website: z.string().max(0).optional(),
  })
  .strict();

export type SubmitInput = z.infer<typeof submitSchema>;

export const statusSchema = z
  .object({
    status: z.enum(["pending", "processing", "processed", "failed"]),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export const uuidSchema = z.string().uuid("Invalid entry ID");

export const adminLoginSchema = z
  .object({
    email: emailField,
    password: z.string().min(1, "Password is required").max(200),
  })
  .strict();

const strongPasswordField = z
  .string()
  .min(10, "At least 10 characters")
  .max(200, "Password is too long")
  .refine((v) => /[a-z]/.test(v), "Include a lowercase letter")
  .refine((v) => /[A-Z]/.test(v), "Include an uppercase letter")
  .refine((v) => /[0-9]/.test(v), "Include a number")
  .refine((v) => /[^A-Za-z0-9]/.test(v), "Include a special character");

export const adminJoinCheckSchema = z
  .object({
    email: emailField,
  })
  .strict();

export const adminJoinSchema = z
  .object({
    email: emailField,
    password: strongPasswordField,
    password_confirm: z.string().min(1, "Confirm your password"),
  })
  .strict()
  .refine((data) => data.password === data.password_confirm, {
    message: "Passwords do not match",
    path: ["password_confirm"],
  });

export const PASSWORD_RULES = [
  "At least 10 characters",
  "At least one lowercase letter (a–z)",
  "At least one uppercase letter (A–Z)",
  "At least one number (0–9)",
  "At least one special character (!@#$%^&* etc.)",
];

/* ── Site-user (customer) auth ─────────────────────────────── */

/** POST /api/auth/register */
export const userRegisterSchema = z
  .object({
    email: emailField,
    password: strongPasswordField,
    name: nameField,
    // The custom name for a deceased loved one used on graphics. Optional
    // at signup — it can be added later from the profile portal.
    angel_name: nameField.optional().or(z.literal("").transform(() => undefined)),
    // Honeypot — must be empty/omitted.
    website: z.string().max(0).optional(),
  })
  .strict();

/** POST /api/auth/login */
export const userLoginSchema = z
  .object({
    email: emailField,
    password: z.string().min(1, "Password is required").max(200),
  })
  .strict();

/** PUT /api/auth/profile — all fields optional, only provided ones change. */
export const userProfileUpdateSchema = z
  .object({
    email: emailField.optional(),
    name: nameField.optional(),
    angel_name: nameField
      .optional()
      .or(z.literal("").transform(() => null))
      .or(z.null()),
  })
  .strict()
  .refine(
    (data) => Object.values(data).some((v) => v !== undefined),
    "Provide at least one field to update"
  );

/** POST /api/auth/password — change while logged in. */
export const userChangePasswordSchema = z
  .object({
    current_password: z.string().min(1, "Current password is required").max(200),
    new_password: strongPasswordField,
  })
  .strict();

/** POST /api/auth/forgot-password */
export const userForgotPasswordSchema = z
  .object({
    email: emailField,
    // Honeypot — must be empty/omitted.
    website: z.string().max(0).optional(),
  })
  .strict();

/** POST /api/auth/reset-password */
export const userResetPasswordSchema = z
  .object({
    token: z
      .string()
      .trim()
      .min(32, "Invalid reset link")
      .max(128, "Invalid reset link")
      .refine((v) => /^[a-f0-9]+$/i.test(v), "Invalid reset link"),
    new_password: strongPasswordField,
  })
  .strict();

/** Mailing-list opt-in from the popup / footer. */
export const newsletterSubscribeSchema = z
  .object({
    email: emailField,
    // Honeypot — must be empty/omitted.
    website: z.string().max(0).optional(),
  })
  .strict();

/** Contact page message. */
export const contactSchema = z
  .object({
    name: nameField,
    email: emailField,
    message: z
      .string()
      .transform((value) =>
        value
          .normalize("NFKC")
          .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, "")
          .trim()
      )
      .pipe(
        z
          .string()
          .min(1, "Please write a message")
          .max(2000, "Message is too long (2000 characters max)")
      ),
    // Honeypot — must be empty/omitted.
    website: z.string().max(0).optional(),
  })
  .strict();

/** Shop checkout — the $5 AAG Archive Graphic purchase. */
export const shopCheckoutSchema = z
  .object({
    graphic_code: graphicCodeField,
    angel_name: nameField,
    real_name: nameField,
    email: emailField,
    // Honeypot — must be empty/omitted.
    website: z.string().max(0).optional(),
  })
  .strict();

/** Server-side payment verification after Stripe confirms in the browser. */
export const shopConfirmSchema = z
  .object({
    payment_intent_id: z
      .string()
      .trim()
      .min(5)
      .max(255)
      .refine((v) => /^pi_[A-Za-z0-9_]+$/.test(v), "Invalid payment id"),
  })
  .strict();

/** Anonymous page-view beacon — no PII, visitor_id is a random client UUID. */
export const pageViewSchema = z
  .object({
    visitor_id: z.string().uuid("Invalid visitor id"),
    path: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((v) => v.startsWith("/"), "Invalid path")
      .refine((v) => !/[<>{};`\\]/.test(v), "Invalid path"),
    referrer: z.string().trim().max(500).optional(),
    device: z.enum(["mobile", "tablet", "desktop"]).optional(),
  })
  .strict();

/** Facebook client access token from the JS SDK. */
export const facebookAuthSchema = z
  .object({
    access_token: z
      .string()
      .trim()
      .min(20, "Invalid token")
      .max(1024, "Invalid token")
      .refine((v) => /^[A-Za-z0-9._-]+$/.test(v), "Invalid token"),
  })
  .strict();

export const lookupQuerySchema = z
  .object({
    angel_name: z.string().trim().max(120).optional(),
    real_name: z.string().trim().max(120).optional(),
  })
  .refine((v) => Boolean(v.angel_name || v.real_name), {
    message: "Provide angel_name or real_name",
  });

function slugCode(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export const adminGraphicCreateSchema = z
  .object({
    label: z
      .string()
      .transform(sanitizeText)
      .pipe(
        z
          .string()
          .min(1, "Label is required")
          .max(120, "Label is too long")
          .refine((v) => !/[<>{};`$\\]/.test(v), "Invalid characters")
      ),
    code: z.string().max(64).optional(),
    sort_order: z.coerce.number().int().min(0).max(100000).optional(),
    // Offer countdown: hours until the graphic is vaulted into the archive.
    // Omit (or null) for an offer with no deadline.
    duration_hours: z.coerce
      .number()
      .positive("Duration must be positive")
      .max(24 * 365, "Duration is too long (1 year max)")
      .optional(),
  })
  .strict()
  .transform((data) => {
    const label = data.label;
    let code = sanitizeText(data.code ?? "");
    code = code || slugCode(label) || `graphic-${Date.now().toString(36)}`;
    code = code.replace(/[<>{};`$\\]/g, "").slice(0, 64);
    return {
      label,
      code: code || `graphic-${Date.now().toString(36)}`,
      sort_order: data.sort_order ?? 0,
      duration_hours: data.duration_hours ?? null,
    };
  });

/** Admin newsletter post — subject title, author display name, body. */
export const newsletterPostSchema = z
  .object({
    title: z
      .string()
      .transform(sanitizeText)
      .pipe(
        z
          .string()
          .min(1, "Title is required")
          .max(200, "Title is too long (200 characters max)")
          .refine((v) => !/[<>{};`$\\]/.test(v), "Invalid characters in title")
      ),
    author_name: nameField,
    body: z
      .string()
      .transform((value) =>
        value
          .normalize("NFKC")
          .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, "")
          .trim()
      )
      .pipe(
        z
          .string()
          .min(1, "Write something for the post body")
          .max(10000, "Post is too long (10,000 characters max)")
      ),
  })
  .strict();
