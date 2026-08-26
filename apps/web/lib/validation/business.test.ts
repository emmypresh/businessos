import { describe, expect, it } from "vitest";
import { CreateBusinessSchema } from "./business";

describe("CreateBusinessSchema", () => {
  it("accepts a valid name and slug", () => {
    const result = CreateBusinessSchema.safeParse({
      name: "Acme Hardware",
      slug: "acme-hardware",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a name shorter than 2 characters", () => {
    expect(
      CreateBusinessSchema.safeParse({ name: "A", slug: "a" }).success
    ).toBe(false);
  });

  it("rejects a name longer than 150 characters", () => {
    expect(
      CreateBusinessSchema.safeParse({
        name: "A".repeat(151),
        slug: "a".repeat(10),
      }).success
    ).toBe(false);
  });

  it("rejects a slug with uppercase letters", () => {
    expect(
      CreateBusinessSchema.safeParse({
        name: "Acme",
        slug: "Acme-Hardware",
      }).success
    ).toBe(false);
  });

  it("rejects a slug with consecutive or edge hyphens", () => {
    expect(
      CreateBusinessSchema.safeParse({ name: "Acme", slug: "-acme" }).success
    ).toBe(false);
    expect(
      CreateBusinessSchema.safeParse({ name: "Acme", slug: "acme--hw" })
        .success
    ).toBe(false);
  });

  it("rejects a slug over 63 characters", () => {
    expect(
      CreateBusinessSchema.safeParse({
        name: "Acme",
        slug: "a".repeat(64),
      }).success
    ).toBe(false);
  });
});
