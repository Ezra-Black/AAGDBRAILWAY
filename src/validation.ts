import { z } from "zod";

const nameField = z
  .string()
  .trim()
  .min(1, "Required")
  .max(120, "Must be 120 characters or fewer")
  .refine(
    (v) => !/[<>{};]/.test(v),
    "Contains invalid characters"
  );

export const submitSchema = z.object({
  real_name: nameField,
  angel_name: nameField,
  metadata: z.record(z.unknown()).optional(),
});

export type SubmitInput = z.infer<typeof submitSchema>;

export const statusSchema = z.object({
  status: z.enum(["pending", "processing", "processed", "failed"]),
  metadata: z.record(z.unknown()).optional(),
});

export const uuidSchema = z.string().uuid("Invalid entry ID");
