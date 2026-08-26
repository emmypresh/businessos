import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createTestDbClient } from "./helpers/db-client";
import {
  createOwnerAndBusiness,
  getDefaultLocationId,
  randomUuid,
} from "./helpers/inventory";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("public.create_product idempotency", () => {
  it("identical replay returns the original product, no duplicate", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cp-idem-replay");
    cleanupUserIds.push(userId);
    const key = randomUuid();
    const payload = {
      p_business_id: businessId,
      p_creation_key: key,
      p_name: "Replay Product",
      p_sku: "replay-sku",
      p_selling_price: 1000,
    };

    const first = await client.rpc("create_product", payload);
    expect(first.error).toBeNull();

    const second = await client.rpc("create_product", payload);
    expect(second.error).toBeNull();
    expect(second.data?.id).toBe(first.data!.id);

    const { data: all } = await client.from("products").select("id").eq("sku", "replay-sku");
    expect(all).toHaveLength(1);
  });

  it("NULL-SKU replay works (track_inventory = false)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cp-idem-nullsku");
    cleanupUserIds.push(userId);
    const key = randomUuid();
    const payload = {
      p_business_id: businessId,
      p_creation_key: key,
      p_name: "Service Item",
      p_track_inventory: false,
    };

    const first = await client.rpc("create_product", payload);
    expect(first.error).toBeNull();
    expect(first.data?.sku).toBeNull();

    const second = await client.rpc("create_product", payload);
    expect(second.error).toBeNull();
    expect(second.data?.id).toBe(first.data!.id);
  });

  it("mismatched payload with the same key is rejected", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cp-idem-mismatch");
    cleanupUserIds.push(userId);
    const key = randomUuid();

    const first = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: key,
      p_name: "Original",
      p_sku: "mismatch-sku",
      p_selling_price: 1000,
    });
    expect(first.error).toBeNull();

    const second = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: key,
      p_name: "Original",
      p_sku: "mismatch-sku",
      p_selling_price: 9999, // different
    });
    expect(second.error).not.toBeNull();
    expect(second.error?.message).toContain("PRODUCT_IDEMPOTENCY_KEY_REUSED");
  });

  it("opening stock is created exactly once, and a replay does not duplicate the movement", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cp-idem-opening");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const key = randomUuid();
    const payload = {
      p_business_id: businessId,
      p_creation_key: key,
      p_name: "Opening Stock Product",
      p_sku: "opening-sku",
      p_opening_quantity: 10,
      p_opening_location_id: locationId,
    };

    const first = await client.rpc("create_product", payload);
    expect(first.error).toBeNull();

    const second = await client.rpc("create_product", payload);
    expect(second.error).toBeNull();
    expect(second.data?.id).toBe(first.data!.id);

    const { data: balance } = await client
      .from("inventory_balances")
      .select("quantity")
      .eq("product_id", first.data!.id)
      .eq("inventory_location_id", locationId)
      .single();
    expect(Number(balance?.quantity)).toBe(10);

    const { data: movements } = await client
      .from("inventory_ledger")
      .select("id")
      .eq("product_id", first.data!.id);
    expect(movements).toHaveLength(1);
  });

  it("response-loss style retry (client resubmits after presumed failure) converges on one product", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cp-idem-response-loss");
    cleanupUserIds.push(userId);
    const key = randomUuid();
    const payload = {
      p_business_id: businessId,
      p_creation_key: key,
      p_name: "Response Loss",
      p_sku: "response-loss-sku",
    };

    const first = await client.rpc("create_product", payload);
    expect(first.error).toBeNull();

    const retry = await client.rpc("create_product", payload);
    expect(retry.error).toBeNull();
    expect(retry.data?.id).toBe(first.data!.id);
  });

  it("a retry of the original creation payload still resolves correctly after the product has been renamed/repriced", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cp-idem-post-edit");
    cleanupUserIds.push(userId);
    const key = randomUuid();
    const originalPayload = {
      p_business_id: businessId,
      p_creation_key: key,
      p_name: "Original Name",
      p_sku: "post-edit-sku",
      p_selling_price: 1000,
    };

    const created = await client.rpc("create_product", originalPayload);
    expect(created.error).toBeNull();

    const edit = await client
      .from("products")
      .update({ name: "Renamed Product", selling_price: 5000 })
      .eq("id", created.data!.id);
    expect(edit.error).toBeNull();

    // Retry the ORIGINAL request verbatim — must be recognized from the
    // persisted original canonical request, not rejected merely because
    // the product's current row no longer matches it.
    const replay = await client.rpc("create_product", originalPayload);
    expect(replay.error).toBeNull();
    expect(replay.data?.id).toBe(created.data!.id);
    // The replay returns the product AS IT NOW EXISTS (the edit stands —
    // create_product never reverts application edits), but is still
    // recognized as the same original request rather than rejected.
    expect(replay.data?.name).toBe("Renamed Product");
  });

  describe("cross-namespace: product-creation keys and inventory-movement keys never interact", () => {
    it("no opening stock: an unrelated manual movement using K, then an exact create retry with K, still succeeds", async () => {
      const { client, businessId, userId } = await createOwnerAndBusiness("cp-idem-cross-ns-1");
      cleanupUserIds.push(userId);
      const locationId = await getDefaultLocationId(client, businessId);
      const key = randomUuid();

      const created = await client.rpc("create_product", {
        p_business_id: businessId,
        p_creation_key: key,
        p_name: "No Opening Stock",
        p_sku: "cross-ns-1-sku",
      });
      expect(created.error).toBeNull();

      // A completely unrelated manual movement reuses the SAME uuid value
      // as this product's creation_key, but as a movement idempotency key.
      const unrelatedMovement = await client.rpc("record_inventory_movement", {
        p_business_id: businessId,
        p_product_id: created.data!.id,
        p_inventory_location_id: locationId,
        p_movement_type: "OPENING_STOCK",
        p_quantity: 5,
        p_idempotency_key: key,
        p_reason: "Unrelated movement reusing the creation_key value",
      });
      expect(unrelatedMovement.error).toBeNull();

      const replay = await client.rpc("create_product", {
        p_business_id: businessId,
        p_creation_key: key,
        p_name: "No Opening Stock",
        p_sku: "cross-ns-1-sku",
      });
      expect(replay.error).toBeNull();
      expect(replay.data?.id).toBe(created.data!.id);
    });

    it("with opening stock (internal key M): an unrelated manual movement using K, then an exact create retry with K, still succeeds and opening stock remains exactly once", async () => {
      const { client, businessId, userId } = await createOwnerAndBusiness("cp-idem-cross-ns-2");
      cleanupUserIds.push(userId);
      const locationId = await getDefaultLocationId(client, businessId);
      const key = randomUuid();
      const payload = {
        p_business_id: businessId,
        p_creation_key: key,
        p_name: "With Opening Stock",
        p_sku: "cross-ns-2-sku",
        p_opening_quantity: 7,
        p_opening_location_id: locationId,
      };

      const created = await client.rpc("create_product", payload);
      expect(created.error).toBeNull();

      // The bundled opening movement used an internally-generated key
      // (never `key` itself) — so `key` is still free to be reused as an
      // unrelated manual movement's own idempotency key without conflict.
      const unrelatedMovement = await client.rpc("record_inventory_movement", {
        p_business_id: businessId,
        p_product_id: created.data!.id,
        p_inventory_location_id: locationId,
        p_movement_type: "ADJUSTMENT_IN",
        p_quantity: 3,
        p_idempotency_key: key,
        p_reason: "Unrelated movement reusing the creation_key value",
      });
      expect(unrelatedMovement.error).toBeNull();

      const replay = await client.rpc("create_product", payload);
      expect(replay.error).toBeNull();
      expect(replay.data?.id).toBe(created.data!.id);

      const { data: movements } = await client
        .from("inventory_ledger")
        .select("quantity_delta")
        .eq("product_id", created.data!.id)
        .order("created_at", { ascending: true });
      // Exactly two ledger rows: the one opening-stock movement (applied
      // once, never duplicated by the replay) and the one unrelated
      // manual movement — never a third row.
      expect(movements).toHaveLength(2);
      expect(Number(movements![0].quantity_delta)).toBe(7);
      expect(Number(movements![1].quantity_delta)).toBe(3);

      const { data: balance } = await client
        .from("inventory_balances")
        .select("quantity")
        .eq("product_id", created.data!.id)
        .eq("inventory_location_id", locationId)
        .single();
      expect(Number(balance?.quantity)).toBe(10);
    });
  });

  describe("concurrency — real Supabase API, strict assertions", () => {
    it("A. same key + identical complete payload, run concurrently: both responses reference one product, exactly one opening movement", async () => {
      const { client, businessId, userId } = await createOwnerAndBusiness("cp-conc-identical");
      cleanupUserIds.push(userId);
      const locationId = await getDefaultLocationId(client, businessId);
      const key = randomUuid();
      const payload = {
        p_business_id: businessId,
        p_creation_key: key,
        p_name: "Concurrent Identical",
        p_sku: "conc-identical-sku",
        p_opening_quantity: 10,
        p_opening_location_id: locationId,
      };

      const [a, b] = await Promise.all([
        client.rpc("create_product", payload),
        client.rpc("create_product", payload),
      ]);

      expect(a.error).toBeNull();
      expect(b.error).toBeNull();
      expect(a.data?.id).toBe(b.data?.id);

      const { data: products } = await client.from("products").select("id").eq("sku", "conc-identical-sku");
      expect(products).toHaveLength(1);

      const { data: movements } = await client
        .from("inventory_ledger")
        .select("id, quantity_delta")
        .eq("product_id", a.data!.id);
      expect(movements).toHaveLength(1);
      expect(Number(movements![0].quantity_delta)).toBe(10);

      const { data: balance } = await client
        .from("inventory_balances")
        .select("quantity")
        .eq("product_id", a.data!.id)
        .single();
      expect(Number(balance?.quantity)).toBe(10);
    });

    it("B. same key + different opening quantity, 30 concurrent trials: exactly one success, one PRODUCT_IDEMPOTENCY_KEY_REUSED, one product, one movement matching the winner", async () => {
      const TRIALS = 30;
      for (let i = 0; i < TRIALS; i++) {
        const { client, businessId, userId } = await createOwnerAndBusiness(`cp-conc-qty-${i}`);
        cleanupUserIds.push(userId);
        const locationId = await getDefaultLocationId(client, businessId);
        const key = randomUuid();
        const sku = `conc-qty-${i}-sku`;
        const base = {
          p_business_id: businessId,
          p_creation_key: key,
          p_name: "Conflicting Quantity",
          p_sku: sku,
          p_opening_location_id: locationId,
        };

        const [a, b] = await Promise.all([
          client.rpc("create_product", { ...base, p_opening_quantity: 10 }),
          client.rpc("create_product", { ...base, p_opening_quantity: 20 }),
        ]);

        const results = [a, b];
        const successes = results.filter((r) => !r.error);
        const conflicts = results.filter((r) => r.error?.message.includes("PRODUCT_IDEMPOTENCY_KEY_REUSED"));

        expect(successes, `trial ${i}: success count`).toHaveLength(1);
        expect(conflicts, `trial ${i}: conflict count`).toHaveLength(1);

        const { data: products } = await client.from("products").select("id").eq("sku", sku);
        expect(products, `trial ${i}: product count`).toHaveLength(1);

        const { data: ledgerRows } = await client
          .from("inventory_ledger")
          .select("quantity_delta")
          .eq("product_id", products![0].id);
        expect(ledgerRows, `trial ${i}: ledger row count`).toHaveLength(1);

        const { data: balance } = await client
          .from("inventory_balances")
          .select("quantity")
          .eq("product_id", products![0].id)
          .single();

        // Whichever payload won, its quantity is what's actually recorded
        // — never a blend, never both, never neither.
        expect([10, 20]).toContain(Number(balance?.quantity));
        expect(Number(ledgerRows![0].quantity_delta)).toBe(Number(balance?.quantity));
        expect(successes[0].data?.id).toBe(products![0].id);
      }
    });

    it("C. same key + different opening location, 15 concurrent trials: exactly one canonical request wins", async () => {
      const TRIALS = 15;
      for (let i = 0; i < TRIALS; i++) {
        const { client, businessId, userId } = await createOwnerAndBusiness(`cp-conc-loc-${i}`);
        cleanupUserIds.push(userId);
        const locationA = await getDefaultLocationId(client, businessId);

        // A second location must be created via a raw SQL fixture — no
        // location-management RPC exists in Phase 1C.
        const sql = createTestDbClient();
        let secondLocationId: string;
        try {
          const [row] = await sql`
            insert into public.inventory_locations (business_id, name, is_default, status, created_by)
            values (${businessId}, 'Warehouse', false, 'active', ${userId})
            returning id
          `;
          secondLocationId = row.id;
        } finally {
          await sql.end();
        }

        const key = randomUuid();
        const sku = `conc-loc-${i}-sku`;
        const base = {
          p_business_id: businessId,
          p_creation_key: key,
          p_name: "Conflicting Location",
          p_sku: sku,
          p_opening_quantity: 5,
        };

        const [a, b] = await Promise.all([
          client.rpc("create_product", { ...base, p_opening_location_id: locationA }),
          client.rpc("create_product", { ...base, p_opening_location_id: secondLocationId }),
        ]);

        const results = [a, b];
        const successes = results.filter((r) => !r.error);
        const conflicts = results.filter((r) => r.error?.message.includes("PRODUCT_IDEMPOTENCY_KEY_REUSED"));

        expect(successes, `trial ${i}: success count`).toHaveLength(1);
        expect(conflicts, `trial ${i}: conflict count`).toHaveLength(1);

        const { data: products } = await client.from("products").select("id").eq("sku", sku);
        expect(products, `trial ${i}: product count`).toHaveLength(1);

        const { data: ledgerRows } = await client
          .from("inventory_ledger")
          .select("inventory_location_id")
          .eq("product_id", products![0].id);
        expect(ledgerRows, `trial ${i}: ledger row count`).toHaveLength(1);
        expect([locationA, secondLocationId]).toContain(ledgerRows![0].inventory_location_id);
      }
    });

    it("D. same key + opening vs. no opening, 15 concurrent trials: one wins, the other is rejected", async () => {
      const TRIALS = 15;
      for (let i = 0; i < TRIALS; i++) {
        const { client, businessId, userId } = await createOwnerAndBusiness(`cp-conc-opt-${i}`);
        cleanupUserIds.push(userId);
        const locationId = await getDefaultLocationId(client, businessId);
        const key = randomUuid();
        const sku = `conc-opt-${i}-sku`;

        const [a, b] = await Promise.all([
          client.rpc("create_product", {
            p_business_id: businessId,
            p_creation_key: key,
            p_name: "Opening vs None",
            p_sku: sku,
            p_opening_quantity: 8,
            p_opening_location_id: locationId,
          }),
          client.rpc("create_product", {
            p_business_id: businessId,
            p_creation_key: key,
            p_name: "Opening vs None",
            p_sku: sku,
          }),
        ]);

        const results = [a, b];
        const successes = results.filter((r) => !r.error);
        const conflicts = results.filter((r) => r.error?.message.includes("PRODUCT_IDEMPOTENCY_KEY_REUSED"));

        expect(successes, `trial ${i}: success count`).toHaveLength(1);
        expect(conflicts, `trial ${i}: conflict count`).toHaveLength(1);

        const { data: products } = await client.from("products").select("id").eq("sku", sku);
        expect(products, `trial ${i}: product count`).toHaveLength(1);

        const { data: ledgerRows } = await client
          .from("inventory_ledger")
          .select("id")
          .eq("product_id", products![0].id);
        // Either 0 (the no-opening request won) or 1 (the opening request
        // won) — never ambiguous, never both applied.
        expect([0, 1]).toContain(ledgerRows!.length);
      }
    });

    it("E. same key + different product metadata (name/price/SKU), concurrently: conflict rejected", async () => {
      const { client, businessId, userId } = await createOwnerAndBusiness("cp-conc-metadata");
      cleanupUserIds.push(userId);
      const key = randomUuid();

      const [a, b] = await Promise.all([
        client.rpc("create_product", {
          p_business_id: businessId,
          p_creation_key: key,
          p_name: "Name A",
          p_sku: "meta-sku-a",
          p_selling_price: 1000,
        }),
        client.rpc("create_product", {
          p_business_id: businessId,
          p_creation_key: key,
          p_name: "Name B",
          p_sku: "meta-sku-b",
          p_selling_price: 2000,
        }),
      ]);

      const results = [a, b];
      const successes = results.filter((r) => !r.error);
      const conflicts = results.filter((r) => r.error?.message.includes("PRODUCT_IDEMPOTENCY_KEY_REUSED"));
      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(1);

      const { data: products } = await client
        .from("products")
        .select("id")
        .in("sku", ["meta-sku-a", "meta-sku-b"]);
      expect(products).toHaveLength(1);
    });
  });
});
