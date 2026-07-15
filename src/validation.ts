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

export const lookupQuerySchema = z
  .object({
    angel_name: z.string().trim().max(120).optional(),
    real_name: z.string().trim().max(120).optional(),
  })
  .refine((v) => Boolean(v.angel_name || v.real_name), {
    message: "Provide angel_name or real_name",
  });
