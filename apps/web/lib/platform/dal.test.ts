import { describe, expect, it, vi, beforeEach } from "vitest";

const { requireUser, getAssuranceLevel } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getAssuranceLevel: vi.fn(),
}));
vi.mock("@/lib/auth/dal", () => ({ requireUser, getAssuranceLevel }));

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ rpc })),
}));

const { notFound, redirect } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("next/navigation", () => ({ notFound, redirect }));

import {
  hasPlatformPermission,
  requirePlatformPermission,
  requireAnyPlatformPermission,
  requirePlatformAdmin,
  getPlatformRole,
} from "./dal";
import { PLATFORM_PERMISSION, type PlatformPermissionKey } from "./constants";

beforeEach(() => {
  requireUser.mockReset().mockResolvedValue({ id: "user-1" });
  getAssuranceLevel.mockReset().mockResolvedValue("aal2");
  rpc.mockReset();
  notFound.mockClear();
  redirect.mockClear();
});

describe("hasPlatformPermission", () => {
  it("calls has_platform_permission with no user id — identity is never forwarded by the client", async () => {
    rpc.mockResolvedValue({ data: true, error: null });

    await expect(
      hasPlatformPermission(PLATFORM_PERMISSION.DASHBOARD_VIEW)
    ).resolves.toBe(true);

    expect(rpc).toHaveBeenCalledWith("has_platform_permission", {
      p_permission_key: "platform.dashboard.view",
    });
    expect(rpc.mock.calls[0][1]).not.toHaveProperty("p_user_id");
  });

  it("returns false when the RPC reports no permission (non-admin, inactive admin, or missing role)", async () => {
    rpc.mockResolvedValue({ data: false, error: null });

    await expect(
      hasPlatformPermission(PLATFORM_PERMISSION.DASHBOARD_VIEW)
    ).resolves.toBe(false);
  });

  it("throws on a query error rather than treating it as \"no permission\"", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "connection reset" } });

    await expect(
      hasPlatformPermission(PLATFORM_PERMISSION.DASHBOARD_VIEW)
    ).rejects.toThrow(/Failed to resolve platform permission/);
  });

  it("requires an authenticated user before ever calling the RPC", async () => {
    requireUser.mockRejectedValue(new Error("redirect to /login"));

    await expect(
      hasPlatformPermission(PLATFORM_PERMISSION.DASHBOARD_VIEW)
    ).rejects.toThrow("redirect to /login");
    expect(rpc).not.toHaveBeenCalled();
  });
});

// Routes the two distinct RPCs requirePlatformPermission's chain can call
// (get_my_platform_role via requirePlatformAdmin, has_platform_permission
// via hasPlatformPermission) to independently controllable results, so
// tests can isolate "not an admin at all" from "admin but missing this
// permission" instead of one shared mock conflating them.
function mockRpc({ role, permitted }: { role: string | null; permitted: boolean }) {
  rpc.mockImplementation(async (fn: string) => {
    if (fn === "get_my_platform_role") return { data: role, error: null };
    if (fn === "has_platform_permission") return { data: permitted, error: null };
    throw new Error(`unexpected rpc: ${fn}`);
  });
}

describe("requirePlatformAdmin", () => {
  it("resolves silently for an active platform admin", async () => {
    mockRpc({ role: "SUPER_ADMIN", permitted: true });
    await expect(requirePlatformAdmin()).resolves.toBeUndefined();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("calls notFound() for a non-admin — independent of AAL", async () => {
    mockRpc({ role: null, permitted: false });
    getAssuranceLevel.mockResolvedValue("aal2");

    await expect(requirePlatformAdmin()).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
    // requirePlatformAdmin never even looks at AAL — it's the gate that
    // lets an AAL1 admin still reach the MFA challenge route.
    expect(getAssuranceLevel).not.toHaveBeenCalled();
  });
});

describe("requirePlatformPermission", () => {
  it("resolves silently when the caller is an active admin at AAL2 with the permission", async () => {
    mockRpc({ role: "SUPER_ADMIN", permitted: true });
    getAssuranceLevel.mockResolvedValue("aal2");

    await expect(
      requirePlatformPermission(PLATFORM_PERMISSION.DASHBOARD_VIEW)
    ).resolves.toBeUndefined();
    expect(notFound).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("calls notFound() — never a distinguishable access-denied page — for a non-admin, before AAL is even checked", async () => {
    mockRpc({ role: null, permitted: false });
    getAssuranceLevel.mockResolvedValue("aal2");

    await expect(
      requirePlatformPermission(PLATFORM_PERMISSION.DASHBOARD_VIEW)
    ).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("redirects an active admin at AAL1 to the MFA challenge route, rather than denying outright", async () => {
    mockRpc({ role: "SUPER_ADMIN", permitted: true });
    getAssuranceLevel.mockResolvedValue("aal1");

    await expect(
      requirePlatformPermission(PLATFORM_PERMISSION.DASHBOARD_VIEW)
    ).rejects.toThrow("REDIRECT:/internal/admin/mfa");
    expect(redirect).toHaveBeenCalledWith("/internal/admin/mfa");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("redirects an active admin with no verified AAL (missing/unknown claim) to the MFA challenge route — fails closed, never treated as AAL2", async () => {
    mockRpc({ role: "SUPER_ADMIN", permitted: true });
    getAssuranceLevel.mockResolvedValue(null);

    await expect(
      requirePlatformPermission(PLATFORM_PERMISSION.DASHBOARD_VIEW)
    ).rejects.toThrow("REDIRECT:/internal/admin/mfa");
  });

  it("calls notFound() for an active admin at AAL2 who lacks this specific permission", async () => {
    mockRpc({ role: "VIEWER", permitted: false });
    getAssuranceLevel.mockResolvedValue("aal2");

    await expect(
      requirePlatformPermission(PLATFORM_PERMISSION.SUBSCRIPTIONS_VIEW)
    ).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("never calls has_platform_permission for an AAL1 caller — the DB permission RPC is not reached before redirecting", async () => {
    mockRpc({ role: "SUPER_ADMIN", permitted: true });
    getAssuranceLevel.mockResolvedValue("aal1");

    await expect(
      requirePlatformPermission(PLATFORM_PERMISSION.DASHBOARD_VIEW)
    ).rejects.toThrow("REDIRECT:/internal/admin/mfa");
    expect(rpc).not.toHaveBeenCalledWith(
      "has_platform_permission",
      expect.anything()
    );
  });
});

// Phase 1O-D remediation — requireAnyPlatformPermission's own permission
// check can differ per key (BILLING holds extend_trial but not
// suspend/reactivate), so this mock routes has_platform_permission by the
// specific p_permission_key argument rather than returning one shared
// boolean for every call.
function mockRpcAnyPermission({
  role,
  permitted,
}: {
  role: string | null;
  permitted: PlatformPermissionKey[];
}) {
  rpc.mockImplementation(async (fn: string, args?: Record<string, unknown>) => {
    if (fn === "get_my_platform_role") return { data: role, error: null };
    if (fn === "has_platform_permission") {
      return { data: permitted.includes(args?.p_permission_key as PlatformPermissionKey), error: null };
    }
    throw new Error(`unexpected rpc: ${fn}`);
  });
}

describe("requireAnyPlatformPermission", () => {
  it("resolves silently when the caller holds at least one of the listed permissions", async () => {
    mockRpcAnyPermission({ role: "BILLING", permitted: [PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL] });
    getAssuranceLevel.mockResolvedValue("aal2");

    await expect(
      requireAnyPlatformPermission([
        PLATFORM_PERMISSION.BUSINESSES_SUSPEND,
        PLATFORM_PERMISSION.BUSINESSES_REACTIVATE,
        PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL,
      ])
    ).resolves.toBeUndefined();
    expect(notFound).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("calls notFound() when the caller holds none of the listed permissions — no tenant-role fallback", async () => {
    mockRpcAnyPermission({ role: "SUPPORT", permitted: [] });
    getAssuranceLevel.mockResolvedValue("aal2");

    await expect(
      requireAnyPlatformPermission([
        PLATFORM_PERMISSION.BUSINESSES_SUSPEND,
        PLATFORM_PERMISSION.BUSINESSES_REACTIVATE,
        PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL,
      ])
    ).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("calls notFound() for a non-admin, before AAL is even checked", async () => {
    mockRpcAnyPermission({ role: null, permitted: [PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL] });
    getAssuranceLevel.mockResolvedValue("aal2");

    await expect(
      requireAnyPlatformPermission([PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL])
    ).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("redirects an active admin at AAL1 to the MFA challenge route, rather than denying outright", async () => {
    mockRpcAnyPermission({ role: "BILLING", permitted: [PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL] });
    getAssuranceLevel.mockResolvedValue("aal1");

    await expect(
      requireAnyPlatformPermission([PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL])
    ).rejects.toThrow("REDIRECT:/internal/admin/mfa");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("never calls has_platform_permission for an AAL1 caller", async () => {
    mockRpcAnyPermission({ role: "BILLING", permitted: [PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL] });
    getAssuranceLevel.mockResolvedValue("aal1");

    await expect(
      requireAnyPlatformPermission([PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL])
    ).rejects.toThrow("REDIRECT:/internal/admin/mfa");
    expect(rpc).not.toHaveBeenCalledWith("has_platform_permission", expect.anything());
  });

  it("an inactive admin (get_my_platform_role returns null) is denied regardless of what has_platform_permission would say", async () => {
    mockRpcAnyPermission({ role: null, permitted: [PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL] });
    getAssuranceLevel.mockResolvedValue("aal2");

    await expect(
      requireAnyPlatformPermission([PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL])
    ).rejects.toThrow("NOT_FOUND");
  });
});

describe("getPlatformRole", () => {
  it("returns the role reported by get_my_platform_role, or null", async () => {
    rpc.mockResolvedValue({ data: "SUPER_ADMIN", error: null });

    await expect(getPlatformRole()).resolves.toBe("SUPER_ADMIN");
    expect(rpc).toHaveBeenCalledWith("get_my_platform_role");
  });
});
