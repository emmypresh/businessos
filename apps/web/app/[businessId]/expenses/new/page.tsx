import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { listActiveExpenseCategoriesForPicker } from "@/lib/expenses/dal";
import { ExpenseForm } from "@/components/expenses/expense-form";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default async function NewExpensePage({
  params,
  searchParams,
}: PageProps<"/[businessId]/expenses/new">) {
  const { businessId } = await params;
  const query = await searchParams;

  // expenses.manage is required to even reach this page.
  await requirePermissionOrNotFound(businessId, PERMISSION.EXPENSES_MANAGE);

  // ACTIVE categories only — an archived category can never be selected
  // for a new expense (§5/§29 of the approved plan).
  const categories = await listActiveExpenseCategoriesForPicker(businessId);

  // A caller with expenses.manage but not expenses.view lands back here
  // after a successful create or void (lib/expenses/actions.ts) instead
  // of the expense detail page, which they cannot reach. Both banners are
  // deliberately generic — no expense UUID, expense number, amount, or
  // other expenses.view-protected details are ever rendered here, since
  // this route never checks that permission. Mirrors sales' own
  // create-without-view redirect exactly (Phase 1D correction).
  const created = query.created === "1";
  const voided = query.voided === "1";

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New expense</h1>
      {created ? (
        <Alert data-testid="expense-created-banner">
          <AlertDescription>Expense recorded successfully.</AlertDescription>
        </Alert>
      ) : null}
      {voided ? (
        <Alert data-testid="expense-voided-banner">
          <AlertDescription>Expense voided successfully.</AlertDescription>
        </Alert>
      ) : null}
      {/* A fresh page load — ExpenseForm below mounts fresh here, giving
          it a brand-new creationKey (useState(() => crypto.randomUUID())
          runs again on this fresh mount), never reusing the one from the
          expense that was just created. */}
      <ExpenseForm businessId={businessId} categories={categories.map((c) => ({ id: c.id, name: c.name }))} />
    </div>
  );
}
