import { getPermissions } from "@/lib/business/dal";
import { notFound } from "next/navigation";
import { PERMISSION } from "@/lib/business/constants";
import { listExpenseCategories } from "@/lib/expenses/dal";
import { CategoryListTable } from "@/components/expenses/category-list-table";
import { CreateCategoryDialog } from "@/components/expenses/create-category-dialog";

export default async function ExpenseCategoriesPage({
  params,
}: PageProps<"/[businessId]/expenses/categories">) {
  const { businessId } = await params;

  // Accessible on EITHER expenses.view OR expenses.manage — never
  // expenses.manage alone assumed to imply expenses.view, and never the
  // reverse. Mirrors expense_categories' own SELECT policy exactly
  // (create_expense_categories.sql).
  const permissions = await getPermissions(businessId);
  const canView = permissions.has(PERMISSION.EXPENSES_VIEW);
  const canManage = permissions.has(PERMISSION.EXPENSES_MANAGE);
  if (!canView && !canManage) {
    notFound();
  }

  const categories = await listExpenseCategories(businessId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Expense categories</h1>
          <p className="text-sm text-muted-foreground">
            Archived categories remain visible here as history, but cannot be selected for new
            expenses.
          </p>
        </div>
        {canManage ? <CreateCategoryDialog businessId={businessId} /> : null}
      </div>

      {categories.length === 0 ? (
        <p className="text-muted-foreground">No categories yet.</p>
      ) : (
        <CategoryListTable businessId={businessId} categories={categories} canManage={canManage} />
      )}
    </div>
  );
}
