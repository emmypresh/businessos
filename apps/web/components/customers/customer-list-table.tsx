import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CUSTOMER_STATUS, CUSTOMER_STATUS_LABEL, type CustomerStatus } from "@/lib/customers/constants";
import type { CustomerRow } from "@/lib/customers/dal";

function statusVariant(status: string) {
  if (status === CUSTOMER_STATUS.ACTIVE) return "default" as const;
  if (status === CUSTOMER_STATUS.ARCHIVED) return "outline" as const;
  return "secondary" as const;
}

export function CustomerListTable({
  businessId,
  customers,
}: {
  businessId: string;
  customers: CustomerRow[];
}) {
  if (customers.length === 0) return null;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Phone</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {customers.map((customer) => (
          <TableRow key={customer.id}>
            <TableCell>
              <Link href={`/${businessId}/customers/${customer.id}`} className="font-medium hover:underline">
                {customer.name}
              </Link>
            </TableCell>
            <TableCell>{customer.phone ?? "—"}</TableCell>
            <TableCell>{customer.email ?? "—"}</TableCell>
            <TableCell>
              <Badge variant={statusVariant(customer.status)}>
                {CUSTOMER_STATUS_LABEL[customer.status as CustomerStatus] ?? customer.status}
              </Badge>
            </TableCell>
            <TableCell>{new Date(customer.created_at).toLocaleDateString()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
