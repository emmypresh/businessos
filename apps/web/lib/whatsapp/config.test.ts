import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { getWhatsappConfig, __resetWhatsappConfigCacheForTests } from "@/lib/whatsapp/config";

const VALID = {
  META_WHATSAPP_ACCESS_TOKEN: "token",
  META_WHATSAPP_APP_SECRET: "secret",
  META_WHATSAPP_VERIFY_TOKEN: "verify",
  META_GRAPH_API_VERSION: "v21.0",
  META_WHATSAPP_BUSINESS_ACCOUNT_ID: "waba-1",
  META_WHATSAPP_PHONE_NUMBER_ID: "phone-1",
  META_WHATSAPP_DISPLAY_PHONE_NUMBER: "+15550001111",
  WHATSAPP_CONTROLLED_BUSINESS_ID: "11111111-1111-1111-1111-111111111111",
};

function stubAll(overrides: Partial<typeof VALID> = {}) {
  const merged = { ...VALID, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    vi.stubEnv(key, value as string);
  }
}

beforeEach(() => {
  __resetWhatsappConfigCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetWhatsappConfigCacheForTests();
});

describe("getWhatsappConfig — fails closed", () => {
  it("returns a full config when every value is valid", () => {
    stubAll();
    const config = getWhatsappConfig();
    expect(config).not.toBeNull();
    expect(config?.phoneNumberId).toBe("phone-1");
  });

  it("returns null when nothing is configured", () => {
    expect(getWhatsappConfig()).toBeNull();
  });

  for (const missingKey of Object.keys(VALID)) {
    it(`returns null when ${missingKey} is missing`, () => {
      const overrides = { ...VALID } as Record<string, string>;
      delete overrides[missingKey];
      for (const [key, value] of Object.entries(overrides)) {
        vi.stubEnv(key, value);
      }
      vi.stubEnv(missingKey, "");
      expect(getWhatsappConfig()).toBeNull();
    });
  }

  it("rejects a malformed Graph API version", () => {
    stubAll({ META_GRAPH_API_VERSION: "not-a-version" });
    expect(getWhatsappConfig()).toBeNull();
  });

  it("rejects a non-UUID controlled business id", () => {
    stubAll({ WHATSAPP_CONTROLLED_BUSINESS_ID: "not-a-uuid" });
    expect(getWhatsappConfig()).toBeNull();
  });

  it("never returns a partial config — invalid config is null, not a demo/default value", () => {
    stubAll({ META_WHATSAPP_ACCESS_TOKEN: "" });
    const config = getWhatsappConfig();
    expect(config).toBeNull();
  });
});
