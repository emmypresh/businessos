import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RenameCategoryDialog } from "@/components/expenses/rename-category-dialog";
import { ArchiveCategoryDialog } from "@/components/expenses/archive-category-dialog";
import { EXPENSE_CATEGORY_STATUS } from "@/lib/expenses/constants";
import type { ExpenseCategoryRow } from "@/lib/expenses/dal";

export function CategoryListTable({
  businessId,
  categories,
  canManage,
}: {
  businessId: string;
  categories: ExpenseCategoryRow[];
  canManage: boolean;
}) {
  if (categories.length === 0) return null;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
          {canManage ? <TableHead className="text-right">Actions</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {categories.map((category) => (
          <TableRow key={category.id}>
            <TableCell className="font-medium">{category.name}</TableCell>
            <TableCell>
              <Badge variant={category.status === EXPENSE_CATEGORY_STATUS.ARCHIVED ? "secondary" : "default"}>
                {category.status === EXPENSE_CATEGORY_STATUS.ARCHIVED ? "Archived" : "Active"}
              </Badge>
            </TableCell>
            {canManage ? (
              <TableCell>
                <div className="flex justify-end gap-2">
                  <RenameCategoryDialog
                    businessId={businessId}
                    category={{ id: category.id, name: category.name }}
                  />
                  {category.status === EXPENSE_CATEGORY_STATUS.ACTIVE ? (
                    <ArchiveCategoryDialog
                      businessId={businessId}
                      categoryId={category.id}
                      categoryName={category.name}
                    />
                  ) : null}
                </div>
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
