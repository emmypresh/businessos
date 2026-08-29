import { ROLE_NAME, type RoleName } from "@/lib/business/constants";

/**
 * Verified against the exact seeded role names in
 * supabase/migrations/20260825202821_create_roles_permissions.sql — the
 * same seven roles lib/business/constants.ts's ROLE_NAME already
 * enumerates, ordered here specifically for the role picker (highest
 * standing first). change_member_role/create_business_invitation both
 * take the role NAME as a plain string (`p_role text`), never a role id —
 * this app never looks up a role id itself.
 */
export const ASSIGNABLE_ROLES: RoleName[] = [
  ROLE_NAME.OWNER,
  ROLE_NAME.ADMIN,
  ROLE_NAME.MANAGER,
  ROLE_NAME.SALES,
  ROLE_NAME.INVENTORY,
  ROLE_NAME.ACCOUNTANT,
  ROLE_NAME.VIEWER,
];

/**
 * Verified against the exact CHECK constraint in
 * supabase/migrations/20260828080600_create_business_invitations.sql.
 */
export const INVITATION_STATUS = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  REVOKED: "REVOKED",
  EXPIRED: "EXPIRED",
} as const;

export type InvitationStatus = (typeof INVITATION_STATUS)[keyof typeof INVITATION_STATUS];

export const MAX_ASSIGNABLE_BRANCHES = 50; // mirrors create_business_invitation's/replace_member_branches' own v_max_branches bound
