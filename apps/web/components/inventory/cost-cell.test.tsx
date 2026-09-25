// @vitest-environment jsdom
// Phase 1Q-0C Codex follow-up (finding 3): CostCell previously rendered a
// revealed cost as `revealed.toFixed(2)` — a bare number with no currency
// identity. This proves the shared symbol formatter is used instead, and
// that hidden-cost / error behavior is otherwise unchanged.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CostCell } from "./cost-cell";

const revealMovementCost = vi.fn<
  (businessId: string, ledgerId: string) => Promise<{ cost: number | null } | { error: string }>
>();

vi.mock("@/lib/inventory/actions", () => ({
  revealMovementCost: (...args: [string, string]) => revealMovementCost(...args),
}));

describe("CostCell — currency symbol display", () => {
  afterEach(() => {
    cleanup();
    revealMovementCost.mockReset();
  });

  it.each([
    ["NGN", "₦450.00"],
    ["GBP", "£450.00"],
    ["USD", "$450.00"],
  ])("reveals a %s cost with its symbol, never a bare number", async (currency, expected) => {
    revealMovementCost.mockResolvedValue({ cost: 450 });
    const user = userEvent.setup();

    render(<CostCell businessId="biz-1" ledgerId="ledger-1" currencyCode={currency} />);
    await user.click(screen.getByRole("button", { name: "Show cost" }));

    await waitFor(() => expect(screen.getByText(expected)).toBeInTheDocument());
    expect(screen.queryByText("450.00")).not.toBeInTheDocument();
  });

  it("still shows an error dash on a failed reveal, unaffected by the formatting change", async () => {
    revealMovementCost.mockResolvedValue({ error: "PERMISSION_DENIED" });
    const user = userEvent.setup();

    render(<CostCell businessId="biz-1" ledgerId="ledger-1" currencyCode="NGN" />);
    await user.click(screen.getByRole("button", { name: "Show cost" }));

    await waitFor(() => expect(screen.getByText("—")).toBeInTheDocument());
  });
});
