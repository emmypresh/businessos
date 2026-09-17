// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getPermissions } = vi.hoisted(() => ({ getPermissions: vi.fn() }));
const { getUnreadNotificationCount } = vi.hoisted(() => ({ getUnreadNotificationCount: vi.fn() }));
const { usePathnameMock } = vi.hoisted(() => ({ usePathnameMock: vi.fn() }));

vi.mock("@/lib/business/dal", () => ({ getPermissions }));
vi.mock("@/lib/notifications/dal", () => ({ getUnreadNotificationCount }));
vi.mock("next/navigation", () => ({ usePathname: usePathnameMock }));

const { DashboardShell } = await import("./dashboard-shell");

const businessId = "11111111-1111-4111-8111-111111111111";

function membershipFixture(overrides: Partial<{ businessName: string; roleName: string }> = {}) {
  return {
    business_id: businessId,
    businesses: { name: overrides.businessName ?? "Acme Stores" },
    roles: { name: overrides.roleName ?? "Owner" },
  } as never;
}

describe("DashboardShell — ArchitectUI shell", () => {
  afterEach(cleanup);

  async function renderShell(
    permissionKeys: string[] = [],
    overrides?: Parameters<typeof membershipFixture>[0],
    pathname: string = `/${businessId}`
  ) {
    getPermissions.mockReset();
    getUnreadNotificationCount.mockReset();
    usePathnameMock.mockReset();
    getPermissions.mockResolvedValue(new Set(permissionKeys));
    getUnreadNotificationCount.mockResolvedValue(3);
    usePathnameMock.mockReturnValue(pathname);
    const element = await DashboardShell({ membership: membershipFixture(overrides), children: <div>Page content</div> });
    return render(element);
  }

  it("renders a single main landmark containing the page content", async () => {
    await renderShell();
    const mains = screen.getAllByRole("main");
    expect(mains).toHaveLength(1);
    expect(within(mains[0]).getByText("Page content")).toBeInTheDocument();
  });

  it("renders exactly one nav landmark shared by desktop sidebar and mobile drawer trigger", async () => {
    await renderShell(["reports.view"]);
    // SidebarNav renders a <nav> only in the always-mounted desktop
    // <aside>; the mobile drawer's own <nav> only exists once its Sheet
    // is opened, so exactly one <nav> is present in the initial render.
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
  });

  it("always renders the Overview link regardless of permissions", async () => {
    await renderShell([]);
    const overviewLinks = screen.getAllByRole("link", { name: "Overview" });
    expect(overviewLinks.length).toBeGreaterThan(0);
    expect(overviewLinks[0]).toHaveAttribute("href", `/${businessId}`);
  });

  it("marks the active route via aria-current, and only once", async () => {
    await renderShell(["reports.view"], undefined, `/${businessId}/reports`);
    const current = screen.getAllByRole("link", { current: "page" });
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute("href", `/${businessId}/reports`);
  });

  it("hides permission-gated nav destinations the caller cannot reach and shows the ones it can", async () => {
    await renderShell(["reports.view"]);
    expect(screen.queryAllByRole("link", { name: "Sales" })).toHaveLength(0);
    expect(screen.queryAllByRole("link", { name: "Reports" }).length).toBeGreaterThan(0);
  });

  it("renders the real notification bell control and the real log-out action, and no fake search or placeholder actions", async () => {
    await renderShell(["reports.view"]);
    expect(screen.getAllByRole("button", { name: /notification/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /log out/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
  });

  it("renders the business name safely even when very long, without breaking layout structure", async () => {
    const longName = "A".repeat(120);
    await renderShell(["reports.view"], { businessName: longName });
    expect(screen.getAllByText(longName).length).toBeGreaterThan(0);
  });

  it("never emits a duplicate DOM id across the full shell render", async () => {
    const { container } = await renderShell(["reports.view"]);
    const ids = Array.from(container.querySelectorAll("[id]")).map((el) => el.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
  });
});
