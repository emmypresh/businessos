"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function HistoryFilters({
  products,
}: {
  products: { id: string; name: string; sku: string | null }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  return (
    <Select
      value={searchParams.get("productId") ?? "all"}
      onValueChange={(value) => {
        const params = new URLSearchParams(searchParams.toString());
        if (!value || value === "all") params.delete("productId");
        else params.set("productId", value);
        params.delete("cursor");
        startTransition(() => {
          router.push(`${pathname}?${params.toString()}`);
        });
      }}
    >
      <SelectTrigger className="sm:w-64">
        <SelectValue placeholder="All products" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All products</SelectItem>
        {products.map((product) => (
          <SelectItem key={product.id} value={product.id}>
            {product.name}
            {product.sku ? ` (${product.sku})` : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
