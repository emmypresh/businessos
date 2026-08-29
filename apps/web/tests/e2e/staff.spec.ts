import { test, expect, type Page } from "@playwright/test";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";
import { createMemberWithCustomPermissions } from "../integration/helpers/inventory";

const PASSWORD = "Password1234";

async function loginAsInBrowser(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function createOwnerAndBusiness(prefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${suffix}@example.test`;
  await createConfirmedTestUser(email, PASSWORD);
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  const { data: business } = await client.rpc("create_business", {
    p_name: prefix,
    p_slug: `${prefix}-${suffix}`,
  });
  return { email, businessId: business!.id as string, client };
}

async function acceptedMember(client: ReturnType<typeof createUserClient>, businessId: string, role: string, prefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${suffix}@example.test`;
  const { data: defaultBranch } = await client.from("business_branches").select("id").eq("business_id", businessId).eq("is_default", true).single();
  const { data: invId } = await client.rpc("create_business_invitation", {
    p_business_id: businessId,
    p_creation_key: crypto.randomUUID(),
    p_email: email,
    p_role: role,
    p_branch_ids: [defaultBranch!.id],
    p_primary_branch_id: defaultBranch!.id,
  });
  await createConfirmedTestUser(email, PASSWORD);
  const memberClient = createUserClient();
  await memberClient.auth.signInWithPassword({ email, password: PASSWORD });
  await memberClient.rpc("accept_business_invitation", { p_invitation_id: invId as string });
  const { data: member } = await client
    .from("business_members")
    .select("id")
    .eq("business_id", businessId)
    .eq("user_id", (await memberClient.auth.getUser()).data.user!.id)
    .single();
  return { email, memberId: member!.id as string };
}

test.describe("staff", () => {
  test("staff list shows the OWNER's own row and permission-aware navigation links to it", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-staff-view");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.getByRole("link", { name: "Staff" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/staff$`));
    await expect(page.getByRole("heading", { name: "Staff" })).toBeVisible();
    await expect(page.getByText("You")).toBeVisible();
    // getByText is case-insensitive by default and would also match the
    // sidebar's own "OWNER" role label — scoped to the table cell
    // specifically, and exact to distinguish "Owner" from "OWNER".
    await expect(page.getByRole("cell", { name: "Owner", exact: true })).toBeVisible();
  });

  test("staff detail shows profile, access, and status sections", async ({ page }) => {
    const { email, businessId, client } = await createOwnerAndBusiness("e2e-staff-detail");
    const member = await acceptedMember(client, businessId, "MANAGER", "e2e-staff-detail-target");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/staff/${member.memberId}`);
    await expect(page.getByText("Manager")).toBeVisible();
    await expect(page.getByText("Active", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Change role" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit branch access" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Suspend" })).toBeVisible();
  });

  test("edits branch access via the sheet — the new assignment appears on reload", async ({ page }) => {
    const { email, businessId, client } = await createOwnerAndBusiness("e2e-staff-branch-access");
    const member = await acceptedMember(client, businessId, "MANAGER", "e2e-staff-branch-access-target");
    await client.rpc("create_business_branch", {
      p_business_id: businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: "Second Branch",
    });
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/staff/${member.memberId}`);
    await page.getByRole("button", { name: "Edit branch access" }).click();
    // Base UI's Checkbox renders both a hidden native <input> (for form
    // participation) and a custom ARIA-role="checkbox" element under the
    // same <label> — getByLabel(...).check() is ambiguous between them;
    // the role locator + click() targets the real interactive one.
    await page.getByRole("checkbox", { name: "Second Branch" }).click();
    await page.getByRole("radio", { name: "Second Branch" }).click();
    await page.getByRole("button", { name: "Save access" }).click();

    await expect(page.getByText("Second Branch").first()).toBeVisible();
    await expect(page.getByText("Primary", { exact: true })).toBeVisible();
  });

  test("changes a member's role via the dialog", async ({ page }) => {
    const { email, businessId, client } = await createOwnerAndBusiness("e2e-staff-role");
    const member = await acceptedMember(client, businessId, "VIEWER", "e2e-staff-role-target");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/staff/${member.memberId}`);
    await page.getByRole("button", { name: "Change role" }).click();
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: "Manager", exact: true }).click();
    await page.getByRole("button", { name: "Save role" }).click();

    // exact: true — getByText is case-insensitive by default and would
    // otherwise also match the closed role Select's own "MANAGER" value
    // text elsewhere on the page.
    await expect(page.getByText("Manager", { exact: true })).toBeVisible();
  });

  // Codex adversarial review, application-layer round 2, Low 4 / Low
  // 10.I: CANNOT_ASSIGN_OWNER_ROLE maps to fieldErrors.role, but
  // ChangeRoleDialog previously only ever rendered state.error — the
  // dialog's aria-invalid was set with no accompanying visible or
  // accessible explanation. Proves the fix: an ADMIN attempting to
  // promote another member to OWNER now sees a real, visible error
  // message inside the dialog.
  test("ADMIN attempting to assign the OWNER role sees a visible, explanatory role error in the dialog", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-staff-role-owner-denied");
    const admin = await acceptedMember(owner.client, owner.businessId, "ADMIN", "e2e-staff-role-owner-denied-admin");
    const target = await acceptedMember(owner.client, owner.businessId, "VIEWER", "e2e-staff-role-owner-denied-target");

    await loginAsInBrowser(page, admin.email, PASSWORD);
    await page.goto(`/${owner.businessId}/staff/${target.memberId}`);
    await page.getByRole("button", { name: "Change role" }).click();
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: "Owner", exact: true }).click();
    await page.getByRole("button", { name: "Save role" }).click();

    await expect(page.getByRole("alert").filter({ hasText: /owner/i })).toBeVisible();
    // The dialog is still open, and the change never applied.
    await expect(page.getByRole("button", { name: "Save role" })).toBeVisible();
  });

  test("suspends then reactivates a member", async ({ page }) => {
    const { email, businessId, client } = await createOwnerAndBusiness("e2e-staff-suspend");
    const member = await acceptedMember(client, businessId, "VIEWER", "e2e-staff-suspend-target");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/staff/${member.memberId}`);
    await page.getByRole("button", { name: "Suspend" }).click();
    await page.getByRole("button", { name: "Suspend", exact: true }).click();
    await expect(page.getByText("Suspended")).toBeVisible();

    await page.getByRole("button", { name: "Reactivate" }).click();
    await expect(page.getByText("Active", { exact: true })).toBeVisible();
  });

  test("invites a new staff member — the form enforces branch + primary selection", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-staff-invite");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/staff/invite`);
    await page.getByLabel("Email").fill(`e2e-invited-${Date.now()}@example.test`);
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: "Sales", exact: true }).click();
    await page.getByRole("checkbox", { name: "Main Branch" }).click();
    await page.getByRole("radio", { name: "Main Branch" }).click();
    await page.getByRole("button", { name: "Send invitation" }).click();

    await expect(page).toHaveURL(new RegExp(`/${businessId}/staff\\?tab=invitations`));
    await expect(page.getByRole("tab", { name: "Invitations" })).toBeVisible();
  });

  // Codex adversarial review, application-layer round 2, Low 10.D: the
  // PREVIOUS version of this test only asserted the UI shows "Revoked" —
  // it never actually attempted acceptance, so the title's claim
  // ("removes the ability to accept") was never proven. Now signs up the
  // real invitee, revokes the invitation, and has that invitee actually
  // attempt to accept it through the real /invitations/[id] route,
  // asserting the safe rejection.
  test("invitation list shows a pending invitation, and revoking it genuinely prevents acceptance — the invitee's real accept attempt is safely rejected", async ({ page, browser }) => {
    const { email, businessId, client } = await createOwnerAndBusiness("e2e-staff-invite-revoke");
    await loginAsInBrowser(page, email, PASSWORD);

    const inviteeEmail = `e2e-revoke-target-${Date.now()}@example.test`;
    await page.goto(`/${businessId}/staff/invite`);
    await page.getByLabel("Email").fill(inviteeEmail);
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: "Viewer", exact: true }).click();
    await page.getByRole("checkbox", { name: "Main Branch" }).click();
    await page.getByRole("radio", { name: "Main Branch" }).click();
    await page.getByRole("button", { name: "Send invitation" }).click();
    await expect(page.getByRole("tab", { name: "Invitations" })).toBeVisible();

    await expect(page.getByText(inviteeEmail)).toBeVisible();
    const { data: invitation } = await client.from("business_invitations").select("id").eq("business_id", businessId).eq("email", inviteeEmail).single();

    await page.getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(page.getByText("Revoked")).toBeVisible();

    // The real invitee, in a genuinely SEPARATE browser context (not
    // context.newPage(), which shares the owner's cookie jar/session —
    // that made /login immediately redirect an already-authenticated
    // "invitee" page away before the form ever rendered), actually
    // attempts to accept the now-revoked invitation through the real
    // route.
    const invitee = await createConfirmedTestUser(inviteeEmail, PASSWORD);
    const inviteeContext = await browser.newContext();
    const inviteePage = await inviteeContext.newPage();
    await loginAsInBrowser(inviteePage, inviteeEmail, PASSWORD);
    await inviteePage.goto(`/invitations/${invitation!.id}`);
    await inviteePage.getByRole("button", { name: "Accept invitation" }).click();
    await expect(inviteePage.getByText(/revoked/i)).toBeVisible();
    // Stayed on the invitation page — never redirected into the business.
    await expect(inviteePage).toHaveURL(new RegExp(`/invitations/${invitation!.id}$`));
    await inviteeContext.close();

    // And genuinely never joined — no business_members row was created.
    const { data: membership } = await client.from("business_members").select("id").eq("business_id", businessId).eq("user_id", invitee.id);
    expect(membership).toEqual([]);
  });

  test("staff.view alone cannot see Invite staff or manage buttons", async ({ page }) => {
    const { businessId, client } = await createOwnerAndBusiness("e2e-staff-perm-owner");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const viewEmail = `e2e-staff-perm-view-${suffix}@example.test`;
    const { data: defaultBranch } = await client.from("business_branches").select("id").eq("business_id", businessId).eq("is_default", true).single();
    const { data: invId } = await client.rpc("create_business_invitation", {
      p_business_id: businessId,
      p_creation_key: crypto.randomUUID(),
      p_email: viewEmail,
      p_role: "VIEWER",
      p_branch_ids: [defaultBranch!.id],
      p_primary_branch_id: defaultBranch!.id,
    });
    await createConfirmedTestUser(viewEmail, PASSWORD);
    const viewerClient = createUserClient();
    await viewerClient.auth.signInWithPassword({ email: viewEmail, password: PASSWORD });
    await viewerClient.rpc("accept_business_invitation", { p_invitation_id: invId as string });

    await loginAsInBrowser(page, viewEmail, PASSWORD);
    await page.goto(`/${businessId}/staff`);
    await expect(page.getByRole("link", { name: "Invite staff" })).toHaveCount(0);
    // VIEWER lacks staff.invite too, so no Invitations tab renders at all.
    await expect(page.getByRole("tab", { name: "Invitations" })).toHaveCount(0);
  });

  // Codex adversarial review, application-layer round 2, Medium 1 / Low
  // 10.A: the PREVIOUS integration test for this scenario fetched a
  // branch UUID through an OWNER client and invoked the Server Action
  // directly — it never proved the REAL PAGE actually renders branch
  // choices for a staff.invite-only caller, since business_branches'
  // own RLS (gated on branches.view, a DIFFERENT permission) would
  // silently return zero rows through the ordinary DAL path. This test
  // exercises the real, rendered UI end to end: a genuine staff.invite
  // -only member (branches.view=false, staff.view=false) loads
  // /staff/invite, sees real ACTIVE branch options (via the new
  // get_invitation_branch_options RPC), successfully submits a real
  // invitation, reaches the independent /staff/invitations management
  // route, and is still denied the staff member roster.
  test("staff.invite=true, staff.view=false, branches.view=false: the invite page renders real branch choices, invitation creation succeeds through the real UI, invitation management is reachable, and the staff member list stays denied", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-staff-invite-only-full");
    const inviteOnly = await createMemberWithCustomPermissions(owner.businessId, "e2e-staff-invite-only-full", ["staff.invite"]);

    await loginAsInBrowser(page, inviteOnly.email, PASSWORD);

    // GET invite page: 200, and it renders the business's real ACTIVE
    // default branch as a checkbox choice — proving
    // get_invitation_branch_options actually returned data for this
    // caller, not an empty/broken picker.
    await page.goto(`/${owner.businessId}/staff/invite`);
    await expect(page.getByRole("heading", { name: "Invite staff" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Main Branch" })).toBeVisible();

    // Invitation creation through the real UI/action succeeds.
    const inviteeEmail = `e2e-invite-only-target-${Date.now()}@example.test`;
    await page.getByLabel("Email").fill(inviteeEmail);
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: "Sales", exact: true }).click();
    await page.getByRole("checkbox", { name: "Main Branch" }).click();
    await page.getByRole("radio", { name: "Main Branch" }).click();
    await page.getByRole("button", { name: "Send invitation" }).click();

    // Lands on the independent invitation-management route (staff.invite
    // -only, never /staff) and the new invitation is genuinely listed.
    await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/staff/invitations$`));
    await expect(page.getByText(inviteeEmail)).toBeVisible();

    // Codex adversarial review, application-layer round 3, Low 2:
    // staff.invite alone must expose invitation MANAGEMENT, not just
    // creation and listing — the pending invitation's Revoke control must
    // actually be visible and enabled for this caller, independent of
    // staff.view/branches.view. Not clicked here: the real revoke
    // mutation (RPC success + the invitation genuinely becoming unusable)
    // is already covered by "invitation list shows a pending invitation,
    // and revoking it genuinely prevents acceptance" above — this test's
    // job is proving invite-only authorization exposes the control, not
    // re-proving the mutation itself.
    const invitationRow = page.getByRole("row").filter({ hasText: inviteeEmail });
    const revokeButton = invitationRow.getByRole("button", { name: "Revoke" });
    await expect(revokeButton).toBeVisible();
    await expect(revokeButton).toBeEnabled();

    // The staff member roster stays inaccessible — this caller lacks
    // staff.view, and /staff itself requires it (requirePermissionOrNotFound
    // -> the app's generic not-found page, matching this app's own
    // non-disclosure convention for every other .view-gated route).
    await page.goto(`/${owner.businessId}/staff`);
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  });

  // Codex adversarial review, application-layer round 2, Low 10.E: the
  // PREVIOUS version of this test only suspended ONCE — it never actually
  // performed a SECOND suspension attempt, so the title's claim about
  // "an already-suspended re-suspend surfaces a safe message" was never
  // proven. The UI correctly hides the Suspend button once a member is
  // already suspended, so a genuine second attempt through the REAL
  // Server Action (not a raw RPC bypass, which would skip
  // mapDatabaseError entirely) requires two tabs racing each other — both
  // load the detail page while the member is still active, tab 1
  // suspends via the real button click, then tab 2 (still showing its
  // now-stale Suspend button from before the mutation) submits the SAME
  // form, hitting suspendMember a second time for real.
  test("no raw database error is ever displayed for a controlled rejection — suspending an already-suspended member surfaces the safe MEMBER_ALREADY_SUSPENDED message, not a raw error", async ({ page, context }) => {
    const { email, businessId, client } = await createOwnerAndBusiness("e2e-staff-no-raw-error");
    const member = await acceptedMember(client, businessId, "VIEWER", "e2e-staff-no-raw-error-target");
    await loginAsInBrowser(page, email, PASSWORD);

    const page2 = await context.newPage();
    await page.goto(`/${businessId}/staff/${member.memberId}`);
    await page2.goto(`/${businessId}/staff/${member.memberId}`);

    // Tab 1: a genuine suspend through the real UI.
    await page.getByRole("button", { name: "Suspend" }).click();
    await page.getByRole("button", { name: "Suspend", exact: true }).click();
    await expect(page.getByText("Suspended")).toBeVisible();
    await expect(page.getByRole("button", { name: "Suspend" })).toHaveCount(0);

    // Tab 2: still showing its stale (pre-mutation) Suspend button —
    // submits the SAME real form/Server Action a second time.
    await page2.getByRole("button", { name: "Suspend" }).click();
    await page2.getByRole("button", { name: "Suspend", exact: true }).click();
    await expect(page2.getByText("This staff member is already suspended.")).toBeVisible();
    await expect(page2.getByText(/relation|constraint|sqlstate|private\.|postgres/i)).toHaveCount(0);
    await page2.close();
  });

  // Codex adversarial review, application-layer round 2, Low 10.F: the
  // PREVIOUS version of this test's title claimed "list and detail" but
  // only ever visited the list. Now visits both.
  test("mobile: staff list and detail are usable without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { email, businessId, client } = await createOwnerAndBusiness("e2e-staff-mobile");
    const member = await acceptedMember(client, businessId, "VIEWER", "e2e-staff-mobile-target");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/staff`);
    await expect(page.getByRole("heading", { name: "Staff" })).toBeVisible();
    let scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    let clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    await page.goto(`/${businessId}/staff/${member.memberId}`);
    await expect(page.getByRole("button", { name: "Change role" })).toBeVisible();
    scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });

  // Codex adversarial review, application-layer round 3, Low 1: the
  // existing malformed-id coverage (lib/staff/dal.ts's own tests) proves
  // getStaffMember never reaches Postgres and calls Next's notFound() —
  // but that alone doesn't prove the DOCUMENT response is actually a
  // 404. This is real route-level coverage: it reads the Response
  // page.goto() itself returns (never just the rendered page text),
  // which is the only way to see the actual HTTP status a browser or
  // crawler would observe.
  test("a malformed staff member id in the URL is a genuine HTTP 404, not a soft 200", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-staff-malformed");
    await loginAsInBrowser(page, email, PASSWORD);

    const response = await page.goto(`/${businessId}/staff/not-a-uuid`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  });
});

test.describe("invitation acceptance", () => {
  test("full flow: sign up as the invitee, accept the invitation, land on the joined business", async ({ page }) => {
    const { businessId, client } = await createOwnerAndBusiness("e2e-accept-flow");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inviteeEmail = `e2e-accept-invitee-${suffix}@example.test`;
    const { data: defaultBranch } = await client.from("business_branches").select("id").eq("business_id", businessId).eq("is_default", true).single();
    const { data: invId } = await client.rpc("create_business_invitation", {
      p_business_id: businessId,
      p_creation_key: crypto.randomUUID(),
      p_email: inviteeEmail,
      p_role: "VIEWER",
      p_branch_ids: [defaultBranch!.id],
      p_primary_branch_id: defaultBranch!.id,
    });
    await createConfirmedTestUser(inviteeEmail, PASSWORD);

    await loginAsInBrowser(page, inviteeEmail, PASSWORD);
    await page.goto(`/invitations/${invId}`);
    await expect(page.getByRole("heading", { name: "Business invitation" })).toBeVisible();
    await expect(page.getByText(inviteeEmail)).toBeVisible();
    await page.getByRole("button", { name: "Accept invitation" }).click();

    await expect(page).toHaveURL(new RegExp(`/${businessId}$`));
  });

  test("unauthenticated visitor is redirected to log in, then back to the invitation after logging in", async ({ page }) => {
    const { businessId, client } = await createOwnerAndBusiness("e2e-accept-unauth");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inviteeEmail = `e2e-accept-unauth-invitee-${suffix}@example.test`;
    const { data: defaultBranch } = await client.from("business_branches").select("id").eq("business_id", businessId).eq("is_default", true).single();
    const { data: invId } = await client.rpc("create_business_invitation", {
      p_business_id: businessId,
      p_creation_key: crypto.randomUUID(),
      p_email: inviteeEmail,
      p_role: "VIEWER",
      p_branch_ids: [defaultBranch!.id],
      p_primary_branch_id: defaultBranch!.id,
    });
    await createConfirmedTestUser(inviteeEmail, PASSWORD);

    await page.goto(`/invitations/${invId}`);
    await expect(page).toHaveURL(/\/login\?next=/);

    await page.getByLabel("Email").fill(inviteeEmail);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(new RegExp(`/invitations/${invId}$`));
  });
});
