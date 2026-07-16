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
    };
  });
