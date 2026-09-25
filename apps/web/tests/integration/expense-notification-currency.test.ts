import { describe, expect, it, afterEach } from "vitest";
import { createAdminClient, deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, setBusinessCountryCurrencyForTest } from "./helpers/inventory";
import { getDefaultCategoryId, makeExpense } from "./helpers/expenses";
import { createTestDbClient } from "./helpers/db-client";

// Phase 1Q-0C Codex follow-up (finding 1): create_expense's expense.posted
// notification body used to render a raw amount with no currency identity
// at all (e.g. "Payee — 100 via CASH"), regardless of which currency the
// owning business actually uses. This proves the fix
// (20260925080000_expense_notification_currency_symbol.sql) end to end,
// against a real database, across NGN/GHS/KES/GBP/USD — never asserting
// against the SQL text itself. The non-NGN activation gate stays CLOSED
// throughout (fixtures use setBusinessCountryCurrencyForTest, matching
// tests/integration/products-currency.test.ts's own pattern), never a
// live create_business call with a non-NG country.

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function notificationBodyFor(businessId: string, expenseId: string) {
  const sql = createTestDbClient();
  try {
    const rows = await sql<{ body: string | null }[]>`
      select body from public.notifications
      where business_id = ${businessId} and resource_type = 'expense' and resource_id = ${expenseId}
    `;
    return rows[0]?.body ?? null;
  } finally {
    await sql.end();
  }
}

describe("create_expense's expense.posted notification body carries the owning business's currency symbol", () => {
  const cases: Array<{ country: string; currency: string; symbol: string }> = [
    { country: "NG", currency: "NGN", symbol: "₦" },
    { country: "GH", currency: "GHS", symbol: "GH₵" },
    { country: "KE", currency: "KES", symbol: "KSh" },
    { country: "GB", currency: "GBP", symbol: "£" },
    { country: "US", currency: "USD", symbol: "$" },
  ];

  for (const { country, currency, symbol } of cases) {
    it(`renders ${currency} amounts with ${symbol}, never a bare number`, async () => {
      const owner = await createOwnerAndBusiness(`exp-notif-cur-${currency.toLowerCase()}`);
      cleanupUserIds.push(owner.userId);
      if (country !== "NG") {
        await setBusinessCountryCurrencyForTest(owner.businessId, country, currency);
      }

      const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
      const expenseId = await makeExpense(owner.client, owner.businessId, categoryId, {
        amount: 1234.56,
        payee: "Test Payee",
        paymentMethod: "CASH",
      });

      const body = await notificationBodyFor(owner.businessId, expenseId);
      expect(body).not.toBeNull();
      expect(body).toBe(`Test Payee — ${symbol}1,234.56 via CASH.`);
      // Never the bare ISO code, and never a currency-less raw number.
      expect(body).not.toContain(`${currency} 1234.56`);
      expect(body).not.toMatch(/— 1234\.56 via/);

      const cleanupSql = createTestDbClient();
      try {
        await cleanupSql`delete from public.notifications where business_id = ${owner.businessId}`;
      } finally {
        await cleanupSql.end();
      }
    });
  }

  it("keeps the audit-event amount as a plain machine-readable string, unaffected by the notification's display formatting", async () => {
    const owner = await createOwnerAndBusiness("exp-notif-cur-audit");
    cleanupUserIds.push(owner.userId);

    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const expenseId = await makeExpense(owner.client, owner.businessId, categoryId, { amount: 500 });

    const admin = createAdminClient();
    const { data, error } = await admin
      .from("audit_events")
      .select("metadata")
      .eq("business_id", owner.businessId)
      .eq("resource_id", expenseId)
      .eq("action", "expense.posted")
      .single();
    expect(error).toBeNull();
    expect((data?.metadata as { amount?: string } | null)?.amount).toBe("500.00");

    const cleanupSql = createTestDbClient();
    try {
      await cleanupSql`delete from public.notifications where business_id = ${owner.businessId}`;
      await cleanupSql`delete from public.audit_events where business_id = ${owner.businessId}`;
    } finally {
      await cleanupSql.end();
    }
  });
});
