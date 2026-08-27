import { requirePermissionOrNotFound, getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getExpense } from "@/lib/expenses/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { VoidExpenseDialog } from "@/components/expenses/void-expense-dialog";
import { formatMoney } from "@/lib/currency";
import { EXPENSE_STATUS, PAYMENT_METHOD_LABEL, type PaymentMethod } from "@/lib/expenses/constants";

export default async function ExpenseDetailPage({
  params,
}: PageProps<"/[businessId]/expenses/[expenseId]">) {
  const { businessId, expenseId } = await params;

  await requirePermissionOrNotFound(businessId, PERMISSION.EXPENSES_VIEW);
  const permissions = await getPermissions(businessId);
  const canManage = permissions.has(PERMISSION.EXPENSES_MANAGE);

  // Scoped by BOTH business_id and expense_id (lib/expenses/dal.ts) — a
  // forged/foreign expenseId renders identically to a nonexistent one
  // (notFound()), never distinguishing the two.
  const expense = await getExpense(businessId, expenseId);
  const isVoided = expense.status === EXPENSE_STATUS.VOIDED;

  return (
    <div className="flex flex-col gap-6" data-testid="expense-detail">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{expense.expense_number}</h1>
          <p className="text-sm text-muted-foreground">
            {new Date(expense.incurred_at).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge data-testid="expense-status-badge" variant={isVoided ? "secondary" : "default"}>
            {isVoided ? "Voided" : "Posted"}
          </Badge>
          {canManage && !isVoided ? (
            <VoidExpenseDialog
              businessId={businessId}
              expenseId={expense.id}
              expenseNumber={expense.expense_number}
            />
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <dl className="grid grid-cols-2 gap-y-1">
              <dt className="text-muted-foreground">Amount</dt>
              <dd className="font-medium">{formatMoney(expense.amount, expense.currency_code)}</dd>
              {/* Rendered from the expense's OWN historical snapshot —
                  never a join to the live expense_categories row. A
                  later category rename or archive never changes what
                  this page shows. */}
              <dt className="text-muted-foreground">Category</dt>
              <dd>{expense.category_name_snapshot}</dd>
              <dt className="text-muted-foreground">Payment method</dt>
              <dd>{PAYMENT_METHOD_LABEL[expense.payment_method as PaymentMethod] ?? expense.payment_method}</dd>
              <dt className="text-muted-foreground">Payee</dt>
              <dd>{expense.payee ?? "—"}</dd>
              <dt className="text-muted-foreground">Reference</dt>
              <dd>{expense.reference ?? "—"}</dd>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Record history</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <dl className="grid grid-cols-2 gap-y-1">
              <dt className="text-muted-foreground">Created</dt>
              <dd>{new Date(expense.created_at).toLocaleString()}</dd>
              {isVoided ? (
                <>
                  <dt className="text-muted-foreground">Voided</dt>
                  <dd>{expense.voided_at ? new Date(expense.voided_at).toLocaleString() : "—"}</dd>
                  <dt className="text-muted-foreground">Void reason</dt>
                  <dd className="whitespace-pre-wrap">{expense.void_reason ?? "—"}</dd>
                </>
              ) : null}
            </dl>
          </CardContent>
        </Card>
      </div>

      {expense.notes ? (
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent className="text-sm whitespace-pre-wrap">{expense.notes}</CardContent>
        </Card>
      ) : null}
    </div>
  );
}
