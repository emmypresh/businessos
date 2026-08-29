"use client";

import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

// A deliberately narrow, DAL-agnostic shape — this component is used both
// by the staff-invite form (fed from lib/staff/dal.ts's
// listInvitationBranchOptions, staff.invite-gated) and the
// edit-branch-access sheet (fed from lib/branches/dal.ts's
// listActiveBranchesForPicker, branches.manage-gated) — two DIFFERENT
// authorization paths that happen to converge on the same minimal
// {id, name, code} display shape. This component must never import a
// type from either specific DAL, so it can never accidentally couple to
// one path's privilege model.
export type BranchPickerOption = { id: string; name: string; code: string | null };

/**
 * The shared "which branches, which one is primary" input group — used
 * both by the staff-invite form and the edit-branch-access sheet, mirroring
 * the client-side rules replace_member_branches/create_business_invitation
 * both enforce server-side: at least one branch selected, primary must be
 * one of the selected branches, only ACTIVE branches are offered at all
 * (an inactive branch is never selectable here, matching those RPCs' own
 * BRANCH_NOT_ACTIVE check). The RPC remains the actual authority; this
 * only gives immediate feedback and renders the correct `branchIds`/
 * `primaryBranchId` hidden inputs for the enclosing <form>.
 */
export function BranchAssignmentFields({
  branches,
  defaultSelectedIds = [],
  defaultPrimaryId,
  error,
}: {
  branches: BranchPickerOption[];
  defaultSelectedIds?: string[];
  defaultPrimaryId?: string;
  error?: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(defaultSelectedIds));
  const [primary, setPrimary] = useState<string | undefined>(defaultPrimaryId);

  function toggle(branchId: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(branchId);
      else next.delete(branchId);
      return next;
    });
    // If the primary branch is unchecked, no primary survives — the
    // caller must explicitly (re-)choose one among what remains checked,
    // mirroring the RPC's own "primary must be in the selected set" rule
    // rather than silently keeping a now-invalid primary selection.
    if (!checked && primary === branchId) {
      setPrimary(undefined);
    }
  }

  if (branches.length === 0) {
    return <p className="text-sm text-muted-foreground">No active branches are available to assign.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label>Assigned branches</Label>
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          {branches.map((branch) => (
            <div key={branch.id} className="flex items-center gap-2">
              <Checkbox
                id={`branch-${branch.id}`}
                checked={selected.has(branch.id)}
                onCheckedChange={(checked) => toggle(branch.id, checked === true)}
              />
              <Label htmlFor={`branch-${branch.id}`} className="flex-1 font-normal">
                {branch.name}
                {branch.code ? <span className="text-muted-foreground"> ({branch.code})</span> : null}
              </Label>
              {selected.has(branch.id) ? (
                <input type="hidden" name="branchIds" value={branch.id} />
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Primary branch</Label>
        {/* Explicit hidden input, not reliance on RadioGroup's own native
            form-association — guarantees `primaryBranchId` always appears
            in FormData exactly once, with exactly this value, regardless
            of how the underlying Base UI primitive participates (or
            doesn't) in native form submission. */}
        <input type="hidden" name="primaryBranchId" value={primary ?? ""} />
        <RadioGroup
          value={primary}
          onValueChange={(value) => setPrimary(value ?? undefined)}
          className="flex flex-col gap-2 rounded-md border border-border p-3"
        >
          {branches
            .filter((b) => selected.has(b.id))
            .map((branch) => (
              <div key={branch.id} className="flex items-center gap-2">
                <RadioGroupItem id={`primary-${branch.id}`} value={branch.id} />
                <Label htmlFor={`primary-${branch.id}`} className="font-normal">
                  {branch.name}
                </Label>
              </div>
            ))}
          {selected.size === 0 ? (
            <p className="text-sm text-muted-foreground">Select at least one branch above first.</p>
          ) : null}
        </RadioGroup>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
