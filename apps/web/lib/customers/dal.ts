import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { encodeCursor, decodeCursor, DEFAULT_PAGE_SIZE, type Cursor } from "@/lib/pagination";
import { buildImatchSearchValue } from "@/lib/search";
import type { CustomerStatus } from "./constants";

// Explicit column list — never select("*"). Every column here is already
// covered by customers' own column-restricted SELECT grant to
// `authenticated` (creation_key does not exist on this table at all —
// idempotency arbitration lives entirely in the private request-ledger
// table, never on customers itself).
const CUSTOMER_COLUMNS =
  "id, business_id, name, phone, email, address, notes, status, created_by, created_at, updated_at";

export type CustomerRow = {
  id: string;
  business_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export const listCustomers = cache(
  async (
    businessId: string,
    options: { search?: string; status?: CustomerStatus; cursor?: string } = {}
  ): Promise<{ rows: CustomerRow[]; nextCursor: string | null }> => {
    await requireUser();
    const supabase = await createClient();

    let query = supabase
      .from("customers")
      .select(CUSTOMER_COLUMNS)
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(DEFAULT_PAGE_SIZE + 1);

    if (options.status) {
      query = query.eq("status", options.status);
    }
    if (options.search) {
      // The same PostgREST-grammar-safe, POSIX-ERE-metacharacter-safe
      // encoder already proven against the real Data API for products —
      // reused verbatim, not reimplemented, per the approved plan.
      const value = buildImatchSearchValue(options.search);
      query = query.or(`name.imatch.${value},phone.imatch.${value},email.imatch.${value}`);
    }

    const cursor = decodeCursor(options.cursor);
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
      );
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to load customers: ${error.message}`);
    }

    const rows = (data ?? []) as unknown as CustomerRow[];
    const hasMore = rows.length > DEFAULT_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, DEFAULT_PAGE_SIZE) : rows;

    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;

    return { rows: page, nextCursor };
  }
);

export const getCustomer = cache(async (businessId: string, customerId: string): Promise<CustomerRow> => {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("customers")
    .select(CUSTOMER_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", customerId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load customer: ${error.message}`);
  }
  if (!data) {
    notFound();
  }

  return data as unknown as CustomerRow;
});

export type { Cursor };
