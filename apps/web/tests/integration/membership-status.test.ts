import { describe, expect, it, afterEach } from "vitest";
import {
  createConfirmedTestUser,
  deleteTestUser,
  createUserClient,
} from "./helpers/admin-client";
import { createTestDbClient } from "./helpers/db-client";

let cleanupUserIds: string[] = [];

afterEach(async () => {
  for (const id of cleanupUserIds) {
    await deleteTestUser(id);
  }
  cleanupUserIds = [];
});

describe("business_members.status enforcement", () => {
  it.each(["suspended", "removed"] as const)(
    "a %s (non-owner) member cannot read the business via RLS",
    async (status) => {
      // The owner can never be deactivated while they're the business's
      // only owner (private.protect_last_owner — verified directly
      // against 20260825202825_owner_membership_and_last_owner_protection.sql,
      // which raises "cannot remove the last owner of a business" for
      // exactly this attempt). So this fixture needs a second, non-owner
      // member instead — which the app itself has no way to create yet
      // (no invite RPC in Phase 1), hence the direct Postgres insert
      // below, same justification as db-client.ts's status update.
      const ownerEmail = `owner-for-status-${status}-${Date.now()}@example.test`;
      const owner = await createConfirmedTestUser(ownerEmail, "Password1234");
      cleanupUserIds.push(owner.id);

      const memberEmail = `member-for-status-${status}-${Date.now()}@example.test`;
      const member = await createConfirmedTestUser(memberEmail, "Password1234");
      cleanupUserIds.push(member.id);

      const ownerClient = createUserClient();
      await ownerClient.auth.signInWithPassword({
        email: ownerEmail,
        password: "Password1234",
      });

      const slug = `status-${status}-${Date.now()}`;
      const { data: business, error: createError } = await ownerClient.rpc(
        "create_business",
        { p_name: "Status Test", p_slug: slug }
      );
      expect(createError).toBeNull();

      const sql = createTestDbClient();
      try {
        // Insert the second member directly with a non-OWNER role, then
        // immediately set the requested status — both steps need the raw
        // connection since there's no INSERT/UPDATE grant for any Supabase
        // API role on business_members.
        await sql`
          insert into public.business_members (business_id, user_id, role_id, status)
          select ${business!.id}, ${member.id}, roles.id, ${status}
          from public.roles
          where roles.name = 'VIEWER'
        `;
      } finally {
        await sql.end();
      }

      const memberClient = createUserClient();
      await memberClient.auth.signInWithPassword({
        email: memberEmail,
        password: "Password1234",
      });

      // Re-derive the row through the same client the app DAL would use —
      // this is what getBusinessMembership's query shape asserts too.
      const { data: membership } = await memberClient
        .from("business_members")
        .select("status")
        .eq("business_id", business!.id)
        .eq("user_id", member.id)
        .eq("status", "active")
        .maybeSingle();
      expect(membership).toBeNull();

      // businesses_select's RLS backstop: even reading the business row
      // directly is denied once the membership isn't active.
      const { data: businessRow } = await memberClient
        .from("businesses")
        .select("id")
        .eq("id", business!.id)
        .maybeSingle();
      expect(businessRow).toBeNull();
    }
  );
});
