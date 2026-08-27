import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import { EXPENSE_STATUS, PAYMENT_METHOD_LABEL, type PaymentMethod } from "@/lib/expenses/constants";
import type { ExpenseRow } from "@/lib/expenses/dal";

export function ExpenseListTable({
  businessId,
  expenses,
}: {
  businessId: string;
  expenses: ExpenseRow[];
}) {
  if (expenses.length === 0) return null;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Expense</TableHead>
          <TableHead>Category</TableHead>
          <TableHead>Amount</TableHead>
          <TableHead>Payment</TableHead>
          <TableHead>Payee</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {expenses.map((expense) => (
          <TableRow key={expense.id} className={expense.status === EXPENSE_STATUS.VOIDED ? "opacity-60" : undefined}>
            <TableCell>
              <Link
                href={`/${businessId}/expenses/${expense.id}`}
                className="font-medium hover:underline"
              >
                {expense.expense_number}
              </Link>
            </TableCell>
            {/* Rendered from the expense's OWN historical snapshot — never
                a join to the live expense_categories row. A later
                category rename never changes what this row shows. */}
            <TableCell>{expense.category_name_snapshot}</TableCell>
            <TableCell className="font-medium">
              {formatMoney(expense.amount, expense.currency_code)}
            </TableCell>
            <TableCell>
              {PAYMENT_METHOD_LABEL[expense.payment_method as PaymentMethod] ?? expense.payment_method}
            </TableCell>
            <TableCell>{expense.payee ?? "—"}</TableCell>
            <TableCell>{new Date(expense.incurred_at).toLocaleDateString()}</TableCell>
            <TableCell>
              <Badge variant={expense.status === EXPENSE_STATUS.VOIDED ? "secondary" : "default"}>
                {expense.status === EXPENSE_STATUS.VOIDED ? "Voided" : "Posted"}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
