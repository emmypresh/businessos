import Link from "next/link";
import { requirePermissionOrNotFound, getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { listExpenses, listExpenseCategories } from "@/lib/expenses/dal";
import { parseExpenseListFilters } from "@/lib/validation/expenses";
import { buttonVariants } from "@/components/ui/button";
import { ExpenseFilters } from "@/components/expenses/expense-filters";
import { ExpenseListTable } from "@/components/expenses/expense-list-table";
import { PaginationLink } from "@/components/pagination-link";

export default async function ExpensesPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/expenses">) {
  const { businessId } = await params;
  const query = await searchParams;

  await requirePermissionOrNotFound(businessId, PERMISSION.EXPENSES_VIEW);
  const permissions = await getPermissions(businessId);
  const canManage = permissions.has(PERMISSION.EXPENSES_MANAGE);

  // Every filter is validated field-by-field here — a malformed
  // categoryId/dateFrom/dateTo (or any other field) in the URL is
  // silently dropped, never forwarded to the DAL/Postgres as a raw
  // string. See lib/validation/expenses.ts's parseExpenseListFilters for
  // the full reasoning.
  const { search, categoryId, paymentMethod, status, dateFrom, dateTo } = parseExpenseListFilters(query);
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;

  const [{ rows, nextCursor }, categories] = await Promise.all([
    listExpenses(businessId, { search, categoryId, paymentMethod, status, dateFrom, dateTo, cursor }),
    listExpenseCategories(businessId),
  ]);

  const hasFilters = Boolean(search || categoryId || paymentMethod || status || dateFrom || dateTo);
  const baseParams = new URLSearchParams({
    ...(search ? { search } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(paymentMethod ? { paymentMethod } : {}),
    ...(status ? { status } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
  });
  const baseHref = `/${businessId}/expenses?${baseParams.toString()}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Expenses</h1>
        <div className="flex gap-2">
          <Link
            href={`/${businessId}/expenses/categories`}
            className={buttonVariants({ variant: "outline" })}
          >
            Categories
          </Link>
          {canManage ? (
            <Link href={`/${businessId}/expenses/new`} className={buttonVariants()}>
              New expense
            </Link>
          ) : null}
        </div>
      </div>

      <ExpenseFilters categories={categories.map((c) => ({ id: c.id, name: c.name }))} />

      {rows.length === 0 ? (
        <p className="text-muted-foreground">
          {hasFilters ? "No expenses match your search." : "No expenses yet."}
          {!hasFilters && canManage ? (
            <>
              {" "}
              <Link href={`/${businessId}/expenses/new`} className="underline underline-offset-4">
                Record your first expense
              </Link>
              .
            </>
          ) : null}
        </p>
      ) : (
        <>
          <ExpenseListTable businessId={businessId} expenses={rows} />
          <PaginationLink href={baseHref} nextCursor={nextCursor} />
        </>
      )}
    </div>
  );
}
