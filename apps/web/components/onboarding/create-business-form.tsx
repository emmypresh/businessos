"use client";

import { useActionState, useMemo, useState } from "react";
import { createBusiness } from "@/lib/business/actions";
import { previewSlug } from "@/lib/slug";
import {
  listSupportedCountries,
  getDefaultCurrencyForCountry,
  getCurrencyDisplayName,
  isFullyOperationalCountry,
  type CountryCode,
} from "@/lib/business/country-currency";
import { getTimezoneOptionsForCountry } from "@/lib/business/timezone-catalog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton } from "@/components/auth/submit-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const COUNTRIES = listSupportedCountries();

export function CreateBusinessForm() {
  const [state, action] = useActionState(createBusiness, undefined);
  const [name, setName] = useState("");
  const [countryCode, setCountryCode] = useState<CountryCode>("NG");

  const timezoneOptions = useMemo(() => getTimezoneOptionsForCountry(countryCode), [countryCode]);
  const [timezone, setTimezone] = useState<string>(timezoneOptions[0]?.value ?? "");

  function handleCountryChange(value: string | null) {
    const next = (value ?? "NG") as CountryCode;
    setCountryCode(next);
    const nextOptions = getTimezoneOptionsForCountry(next);
    setTimezone(nextOptions[0]?.value ?? "");
  }

  const currencyCode = getDefaultCurrencyForCountry(countryCode);
  const fullyOperational = isFullyOperationalCountry(countryCode);

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

      <div className="flex flex-col gap-2">
        <Label htmlFor="country-trigger">Country</Label>
        <input type="hidden" name="countryCode" value={countryCode} />
        <Select value={countryCode} onValueChange={handleCountryChange}>
          <SelectTrigger id="country-trigger" className="w-full" aria-invalid={!!state?.fieldErrors?.countryCode}>
            <SelectValue placeholder="Choose a country" />
          </SelectTrigger>
          <SelectContent>
            {COUNTRIES.map((country) => (
              <SelectItem key={country.countryCode} value={country.countryCode}>
                {country.countryName} ({country.countryCode})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {state?.fieldErrors?.countryCode ? (
          <p role="alert" className="text-sm text-destructive">{state.fieldErrors.countryCode[0]}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label>Base currency</Label>
        <p className="rounded-lg border border-input bg-muted/40 px-2.5 py-2 text-sm text-muted-foreground">
          {currencyCode ? getCurrencyDisplayName(currencyCode) : currencyCode} — set automatically from your
          country. You can&apos;t change this after creating your business.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="timezone-trigger">Timezone</Label>
        <input type="hidden" name="timezone" value={timezone} />
        <Select value={timezone} onValueChange={(v) => setTimezone(v ?? "")}>
          <SelectTrigger id="timezone-trigger" className="w-full" aria-invalid={!!state?.fieldErrors?.timezone}>
            <SelectValue placeholder="Choose a timezone" />
          </SelectTrigger>
          <SelectContent>
            {timezoneOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {state?.fieldErrors?.timezone ? (
          <p role="alert" className="text-sm text-destructive">{state.fieldErrors.timezone[0]}</p>
        ) : null}
      </div>

      {!fullyOperational ? (
        <Alert>
          <AlertDescription>
            BusinessOS currently supports full accounting operations in Nigerian Naira. Support for {" "}
            {COUNTRIES.find((c) => c.countryCode === countryCode)?.countryName ?? "this country"} is being
            completed — you can&apos;t create a business here yet.
          </AlertDescription>
        </Alert>
      ) : null}

      {state?.error ? (
        <Alert variant="destructive" role="alert"><AlertDescription>{state.error}</AlertDescription></Alert>
      ) : null}

      <SubmitButton disabled={!fullyOperational}>Create business</SubmitButton>
    </form>
  );
}
