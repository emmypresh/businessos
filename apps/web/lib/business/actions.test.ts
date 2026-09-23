import { describe, expect, it, vi, beforeEach } from "vitest";

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ requireUser }));

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn() }));
vi.mock("@/lib/business/dal", () => ({ hasPermission }));

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect }));

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ rpc, from })),
}));

import { createBusiness, updateBusinessTimezone } from "@/lib/business/actions";

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: "user-1" });
});

describe("createBusiness — non-NGN activation gate", () => {
  it("rejects a well-formed, catalog-supported non-NG country BEFORE calling create_business", async () => {
    const result = await createBusiness(
      undefined,
      formData({ name: "Accra Traders", slug: "accra-traders", countryCode: "GH", timezone: "Africa/Accra" })
    );
    expect(result?.error).toMatch(/Nigerian Naira/);
    // The actual server boundary: the RPC that would create the tenant is
    // never even invoked — this is not merely a disabled UI affordance.
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(["GH", "KE", "ZA", "GB", "US"])("blocks creation for %s", async (country) => {
    const tzByCountry: Record<string, string> = {
      GH: "Africa/Accra",
      KE: "Africa/Nairobi",
      ZA: "Africa/Johannesburg",
      GB: "Europe/London",
      US: "America/New_York",
    };
    const result = await createBusiness(
      undefined,
      formData({ name: "Test Co", slug: `test-co-${country.toLowerCase()}`, countryCode: country, timezone: tzByCountry[country] })
    );
    expect(result?.error).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("allows NG through to create_business, with the server-derived NGN currency (never client-supplied)", async () => {
    rpc.mockResolvedValue({ data: { id: "biz-1" }, error: null });
    await createBusiness(
      undefined,
      formData({ name: "Lagos Traders", slug: "lagos-traders", countryCode: "NG", timezone: "Africa/Lagos" })
    );
    expect(rpc).toHaveBeenCalledWith(
      "create_business",
      expect.objectContaining({
        p_country_code: "NG",
        p_currency_code: "NGN",
        p_timezone: "Africa/Lagos",
      })
    );
  });

  it("rejects a shape-valid but unsupported country before it ever reaches create_business (1Q-0A low finding)", async () => {
    const result = await createBusiness(
      undefined,
      formData({ name: "Paris Co", slug: "paris-co", countryCode: "FR", timezone: "Europe/Paris" })
    );
    expect(result?.fieldErrors?.countryCode).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("updateBusinessTimezone", () => {
  it("denies a caller without business.manage", async () => {
    hasPermission.mockResolvedValue(false);
    const result = await updateBusinessTimezone(
      undefined,
      formData({ businessId: BUSINESS_ID, timezone: "Africa/Accra" })
    );
    expect(result?.error).toMatch(/permission/i);
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects a timezone outside the business's own country options, even for an authorized caller", async () => {
    hasPermission.mockResolvedValue(true);
    from.mockImplementation((table: string) => {
      if (table === "businesses") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { country_code: "GB" }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
    const result = await updateBusinessTimezone(
      undefined,
      formData({ businessId: BUSINESS_ID, timezone: "America/Chicago" })
    );
    expect(result?.fieldErrors?.timezone).toBeTruthy();
  });

  it("updates the timezone for an authorized caller with a valid timezone for the business's country", async () => {
    hasPermission.mockResolvedValue(true);
    const update = vi.fn(() => ({ eq: async () => ({ error: null }) }));
    from.mockImplementation((table: string) => {
      if (table === "businesses") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { country_code: "US" }, error: null }),
            }),
          }),
          update,
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
    const result = await updateBusinessTimezone(
      undefined,
      formData({ businessId: BUSINESS_ID, timezone: "America/Chicago" })
    );
    expect(update).toHaveBeenCalledWith({ timezone: "America/Chicago" });
    expect(result?.success).toBe(true);
  });
});
