import { describe, expect, it } from "vitest";
import {
  SignUpSchema,
  LoginSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
} from "./auth";

describe("SignUpSchema", () => {
  it("accepts a valid signup", () => {
    const result = SignUpSchema.safeParse({
      email: "Owner@Example.com",
      password: "Password1",
      confirmPassword: "Password1",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("owner@example.com");
    }
  });

  it("rejects a mismatched confirmation", () => {
    const result = SignUpSchema.safeParse({
      email: "owner@example.com",
      password: "Password1",
      confirmPassword: "Password2",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.confirmPassword).toBeDefined();
    }
  });

  it("rejects a password under 8 characters", () => {
    const result = SignUpSchema.safeParse({
      email: "owner@example.com",
      password: "Pass1",
      confirmPassword: "Pass1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a password with no digit", () => {
    const result = SignUpSchema.safeParse({
      email: "owner@example.com",
      password: "Password",
      confirmPassword: "Password",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid email", () => {
    const result = SignUpSchema.safeParse({
      email: "not-an-email",
      password: "Password1",
      confirmPassword: "Password1",
    });
    expect(result.success).toBe(false);
  });
});

describe("LoginSchema", () => {
  it("accepts email + non-empty password", () => {
    expect(
      LoginSchema.safeParse({ email: "a@b.com", password: "x" }).success
    ).toBe(true);
  });

  it("rejects an empty password", () => {
    expect(
      LoginSchema.safeParse({ email: "a@b.com", password: "" }).success
    ).toBe(false);
  });
});

describe("ForgotPasswordSchema", () => {
  it("accepts a valid email", () => {
    expect(
      ForgotPasswordSchema.safeParse({ email: "a@b.com" }).success
    ).toBe(true);
  });

  it("rejects an invalid email", () => {
    expect(
      ForgotPasswordSchema.safeParse({ email: "nope" }).success
    ).toBe(false);
  });
});

describe("ResetPasswordSchema", () => {
  it("accepts matching strong passwords", () => {
    expect(
      ResetPasswordSchema.safeParse({
        password: "Password1",
        confirmPassword: "Password1",
      }).success
    ).toBe(true);
  });

  it("rejects mismatched passwords", () => {
    expect(
      ResetPasswordSchema.safeParse({
        password: "Password1",
        confirmPassword: "Password2",
      }).success
    ).toBe(false);
  });
});
