import { describe, expect, it } from "vitest";
import { CreateCustomerSchema, UpdateCustomerSchema, CustomerFilterSchema } from "./customers";

describe("CreateCustomerSchema", () => {
  const base = { creationKey: crypto.randomUUID(), name: "Jane Doe" };

  it("accepts a minimal valid customer", () => {
    const result = CreateCustomerSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it("accepts every optional field populated", () => {
    const result = CreateCustomerSchema.safeParse({
      ...base,
      phone: "0801234567",
      email: "jane@example.test",
      address: "1 Main St",
      notes: "VIP customer",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a name shorter than 2 characters", () => {
    const result = CreateCustomerSchema.safeParse({ ...base, name: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects a name longer than 200 characters", () => {
    const result = CreateCustomerSchema.safeParse({ ...base, name: "x".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid email format", () => {
    const result = CreateCustomerSchema.safeParse({ ...base, email: "not-an-email" });
    expect(result.success).toBe(false);
  });

  it("rejects a phone longer than 32 characters", () => {
    const result = CreateCustomerSchema.safeParse({ ...base, phone: "0".repeat(33) });
    expect(result.success).toBe(false);
  });

  it("rejects an address longer than 500 characters", () => {
    const result = CreateCustomerSchema.safeParse({ ...base, address: "x".repeat(501) });
    expect(result.success).toBe(false);
  });

  it("rejects notes longer than 2000 characters", () => {
    const result = CreateCustomerSchema.safeParse({ ...base, notes: "x".repeat(2001) });
    expect(result.success).toBe(false);
  });

  it("rejects a missing creationKey", () => {
    const result = CreateCustomerSchema.safeParse({ name: "Jane Doe" });
    expect(result.success).toBe(false);
  });

  it("trims whitespace and treats an all-whitespace optional field as absent", () => {
    const result = CreateCustomerSchema.safeParse({ ...base, phone: "   " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone).toBeUndefined();
    }
  });
});

describe("UpdateCustomerSchema", () => {
  it("requires a valid status", () => {
    const result = UpdateCustomerSchema.safeParse({ name: "Jane Doe", status: "deleted" });
    expect(result.success).toBe(false);
  });

  it("accepts each of the three valid statuses", () => {
    for (const status of ["active", "inactive", "archived"]) {
      const result = UpdateCustomerSchema.safeParse({ name: "Jane Doe", status });
      expect(result.success, status).toBe(true);
    }
  });

  it("never accepts business_id/created_by/id/created_at fields even if supplied — they're simply not part of the shape", () => {
    const result = UpdateCustomerSchema.safeParse({
      name: "Jane Doe",
      status: "active",
      businessId: "forged",
      createdBy: "forged",
      id: "forged",
      createdAt: "forged",
    } as never);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("businessId");
      expect(result.data).not.toHaveProperty("createdBy");
      expect(result.data).not.toHaveProperty("id");
      expect(result.data).not.toHaveProperty("createdAt");
    }
  });
});

describe("CustomerFilterSchema", () => {
  it("accepts an empty filter", () => {
    expect(CustomerFilterSchema.safeParse({}).success).toBe(true);
  });

  it("rejects an invalid status filter", () => {
    expect(CustomerFilterSchema.safeParse({ status: "deleted" }).success).toBe(false);
  });
});
