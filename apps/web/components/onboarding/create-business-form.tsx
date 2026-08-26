"use client";

import { useActionState, useState } from "react";
import { createBusiness } from "@/lib/business/actions";
import { previewSlug } from "@/lib/slug";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";

export function CreateBusinessForm() {
  const [state, action] = useActionState(createBusiness, undefined);
  const [name, setName] = useState("");

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Business name</Label>
        <Input
          id="name"
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={!!state?.fieldErrors?.name}
        />
        {state?.fieldErrors?.name ? <p role="alert" className="text-sm text-destructive">{state.fieldErrors.name[0]}</p> : null}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="slug">URL slug</Label>
        <Input
          id="slug"
          name="slug"
          placeholder={previewSlug(name) || "your-business"}
          aria-invalid={!!state?.fieldErrors?.slug}
        />
        {state?.fieldErrors?.slug ? <p role="alert" className="text-sm text-destructive">{state.fieldErrors.slug[0]}</p> : null}
      </div>
      {state?.error ? (
        <Alert variant="destructive" role="alert"><AlertDescription>{state.error}</AlertDescription></Alert>
      ) : null}
      <SubmitButton>Create business</SubmitButton>
    </form>
  );
}
