import { z } from "zod";

const PasswordSchema = z
  .string()
  .min(8, { error: "Password must be at least 8 characters." })
  .regex(/[a-z]/, { error: "Password must contain a lowercase letter." })
  .regex(/[A-Z]/, { error: "Password must contain an uppercase letter." })
  .regex(/[0-9]/, { error: "Password must contain a number." });

const EmailSchema = z
  .email({ error: "Enter a valid email address." })
  .trim()
  .toLowerCase();

export const SignUpSchema = z
  .object({
    email: EmailSchema,
    password: PasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    error: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export const LoginSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1, { error: "Password is required." }),
});

export const ForgotPasswordSchema = z.object({
  email: EmailSchema,
});

export const ResetPasswordSchema = z
  .object({
    password: PasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    error: "Passwords do not match.",
    path: ["confirmPassword"],
  });

// TOTP codes are exactly 6 digits. Trimmed so a pasted code with
// surrounding whitespace (common on mobile authenticator apps' copy
// buttons) doesn't fail validation before ever reaching Supabase.
export const MfaVerifySchema = z.object({
  factorId: z.uuid({ error: "Invalid MFA factor." }),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, { error: "Enter the 6-digit code from your authenticator app." }),
});

export type SignUpInput = z.infer<typeof SignUpSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;
export type MfaVerifyInput = z.infer<typeof MfaVerifySchema>;
