import { describe, expect, it, vi, beforeEach } from "vitest";

// Mirrors the mocking technique already established by lib/auth/dal.test.ts
// for this exact reason: Server Actions ultimately call next/headers'
// cookies() via lib/supabase/server.ts, which only works inside a real
// Next.js request — mocking the module boundary is what lets these run
// as plain Vitest unit tests while still exercising the ACTUAL action
// code (permission checks, RPC argument construction, ActionState
// shaping), not a reimplementation of it.
const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ requireUser }));

const { getPermissions } = vi.hoisted(() => ({ getPermissions: vi.fn() }));
vi.mock("@/lib/business/dal", () => ({ getPermissions }));

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { rpc, createChain } = vi.hoisted(() => {
  function createChain(finalResult: unknown) {
    const chain: Record<string, unknown> = {};
    chain.update = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.then = (resolve: (v: unknown) => unknown) => resolve(finalResult);
    return chain;
  }
  return { rpc: vi.fn(), createChain };
});
const fromMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ rpc, from: fromMock })),
}));

import { createProduct, updateProduct, archiveProduct } from "./actions";

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const VALID_KEY = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  requireUser.mockReset().mockResolvedValue({ id: "user-1" });
  getPermissions.mockReset();
  rpc.mockReset();
  fromMock.mockReset();
  redirect.mockClear();
});

describe("createProduct — authorization (rule 1)", () => {
  it("returns a permission-denied error and NEVER calls the RPC when products.manage is absent", async () => {
    getPermissions.mockResolvedValue(new Set([]));

    const result = await createProduct(
      undefined,
      formData({
        businessId: "biz-1",
        creationKey: VALID_KEY,
        name: "Should Not Be Created",
        sku: "x",
      })
    );

    expect(result?.error).toBe("You don't have permission to do this.");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("checks authentication before anything else", async () => {
    getPermissions.mockResolvedValue(new Set(["products.manage"]));
    await createProduct(undefined, formData({ businessId: "biz-1", creationKey: VALID_KEY, name: "X", sku: "x" }));
    expect(requireUser).toHaveBeenCalled();
  });
});

describe("createProduct — cost write permission (rule 2)", () => {
  it("never sends a client-supplied cost price when the caller lacks inventory.view_cost, even if the form data has one", async () => {
    getPermissions.mockResolvedValue(new Set(["products.manage"])); // no inventory.view_cost
    rpc.mockResolvedValue({ data: { id: "prod-1" }, error: null });

    await expect(
      createProduct(
        undefined,
        formData({
          businessId: "biz-1",
          creationKey: VALID_KEY,
          name: "No Cost Caller",
          sku: "x",
          costPrice: "9999.99", // attempted client-side smuggling
        })
      )
    ).rejects.toThrow("REDIRECT:");

    expect(rpc).toHaveBeenCalledWith(
      "create_product",
      expect.objectContaining({ p_cost_price: undefined })
    );
  });

  it("includes the cost price when the caller holds inventory.view_cost", async () => {
    getPermissions.mockResolvedValue(new Set(["products.manage", "inventory.view_cost"]));
    rpc.mockResolvedValue({ data: { id: "prod-1" }, error: null });

    await expect(
      createProduct(
        undefined,
        formData({ businessId: "biz-1", creationKey: VALID_KEY, name: "Cost Caller", sku: "x", costPrice: "500" })
      )
    ).rejects.toThrow("REDIRECT:");

    expect(rpc).toHaveBeenCalledWith("create_product", expect.objectContaining({ p_cost_price: 500 }));
  });
});

describe("createProduct — RPC response sanitization (rule 3)", () => {
  it("an error response never contains raw RPC/database fields — only error/fieldErrors", async () => {
    getPermissions.mockResolvedValue(new Set(["products.manage", "inventory.view_cost"]));
    rpc.mockResolvedValue({ data: null, error: { message: "SKU_UNAVAILABLE", code: "23505" } });

    const result = await createProduct(
      undefined,
      formData({ businessId: "biz-1", creationKey: VALID_KEY, name: "Dup", sku: "dup" })
    );

    expect(result).toBeDefined();
    const keys = Object.keys(result ?? {});
    expect(keys).not.toContain("creation_key");
    expect(keys).not.toContain("cost_price");
    expect(keys).not.toContain("data");
    for (const key of keys) {
      expect(["error", "fieldErrors", "success"]).toContain(key);
    }
  });

  it("the redirect target on success is built ONLY from the response's id — never the full RPC row", async () => {
    getPermissions.mockResolvedValue(new Set(["products.manage", "inventory.view_cost"]));
    rpc.mockResolvedValue({
      data: {
        id: "prod-42",
        creation_key: "should-never-appear",
        cost_price: 123.45,
        business_id: "biz-1",
      },
      error: null,
    });

    await expect(
      createProduct(undefined, formData({ businessId: "biz-1", creationKey: VALID_KEY, name: "Widget", sku: "x" }))
    ).rejects.toThrow("REDIRECT:/biz-1/products/prod-42");

    const redirectUrl = redirect.mock.calls[0][0] as string;
    expect(redirectUrl).not.toContain("should-never-appear");
    expect(redirectUrl).not.toContain("123.45");
  });
});

describe("updateProduct — cost write permission (rule 2)", () => {
  it("does not include cost_price in the update payload when inventory.view_cost is absent — the key is absent, not null", async () => {
    getPermissions.mockResolvedValue(new Set(["products.manage"]));
    const chain = createChain({ error: null });
    fromMock.mockReturnValue(chain);

    await expect(
      updateProduct(
        undefined,
        formData({
          businessId: "biz-1",
          productId: "prod-1",
          name: "Renamed",
          unit: "unit",
          sellingPrice: "100",
          costPrice: "9999", // attempted smuggling
        })
      )
    ).rejects.toThrow("REDIRECT:");

    const updatePayload = (chain.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updatePayload).not.toHaveProperty("cost_price");
  });

  it("includes cost_price in the update payload when inventory.view_cost is present", async () => {
    getPermissions.mockResolvedValue(new Set(["products.manage", "inventory.view_cost"]));
    const chain = createChain({ error: null });
    fromMock.mockReturnValue(chain);

    await expect(
      updateProduct(
        undefined,
        formData({
          businessId: "biz-1",
          productId: "prod-1",
          name: "Renamed",
          unit: "unit",
          sellingPrice: "100",
          costPrice: "250",
        })
      )
    ).rejects.toThrow("REDIRECT:");

    const updatePayload = (chain.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updatePayload).toMatchObject({ cost_price: 250 });
  });

  it("denies a caller without products.manage before touching the database", async () => {
    getPermissions.mockResolvedValue(new Set([]));
    const result = await updateProduct(
      undefined,
      formData({ businessId: "biz-1", productId: "prod-1", name: "X", unit: "unit", sellingPrice: "1" })
    );
    expect(result?.error).toBe("You don't have permission to do this.");
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe("archiveProduct — authorization and error mapping", () => {
  it("denies a caller without products.manage", async () => {
    getPermissions.mockResolvedValue(new Set([]));
    const result = await archiveProduct(undefined, formData({ businessId: "biz-1", productId: "prod-1" }));
    expect(result?.error).toBe("You don't have permission to do this.");
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("surfaces CANNOT_ARCHIVE_WITH_STOCK with its mapped message", async () => {
    getPermissions.mockResolvedValue(new Set(["products.manage"]));
    fromMock.mockReturnValue(createChain({ error: { message: "CANNOT_ARCHIVE_WITH_STOCK" } }));

    const result = await archiveProduct(undefined, formData({ businessId: "biz-1", productId: "prod-1" }));
    expect(result?.error).toContain("still has stock recorded");
  });
});
