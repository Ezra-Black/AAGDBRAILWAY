import { z } from "zod";

const nameField = z
  .string()
  .trim()
  .min(1, "Required")
  .max(120, "Must be 120 characters or fewer")
  .refine((v) => !/[<>{};]/.test(v), "Contains invalid characters");

const emailField = z
  .string()
  .trim()
  .min(1, "Email is required")
  .max(254, "Email is too long")
  .email("Enter a valid email");

const graphicCodeField = z
  .string()
  .trim()
  .min(1, "Choose a graphic")
  .max(64, "Invalid graphic code")
  .regex(/^[a-zA-Z0-9_-]+$/, "Invalid graphic code");

export const submitSchema = z.object({
  real_name: nameField,
  angel_name: nameField,
  email: emailField,
  graphic_code: graphicCodeField,
  metadata: z.record(z.unknown()).optional(),
});

export type SubmitInput = z.infer<typeof submitSchema>;

export const statusSchema = z.object({
  status: z.enum(["pending", "processing", "processed", "failed"]),
  metadata: z.record(z.unknown()).optional(),
});

export const uuidSchema = z.string().uuid("Invalid entry ID");

export const adminLoginSchema = z.object({
  email: emailField,
  password: z.string().min(1, "Password is required").max(200),
});
