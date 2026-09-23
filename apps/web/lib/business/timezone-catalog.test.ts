import { describe, expect, it } from "vitest";
import {
  getTimezoneOptionsForCountry,
  isSupportedTimezone,
  isTimezoneValidForCountry,
  listAllTimezoneOptions,
  SUPPORTED_TIMEZONES,
} from "./timezone-catalog";

describe("timezone catalog", () => {
  it("single-timezone countries expose exactly one option", () => {
    expect(getTimezoneOptionsForCountry("NG")).toEqual([{ value: "Africa/Lagos", label: "Lagos (WAT)" }]);
    expect(getTimezoneOptionsForCountry("GH").map((o) => o.value)).toEqual(["Africa/Accra"]);
    expect(getTimezoneOptionsForCountry("KE").map((o) => o.value)).toEqual(["Africa/Nairobi"]);
    expect(getTimezoneOptionsForCountry("ZA").map((o) => o.value)).toEqual(["Africa/Johannesburg"]);
    expect(getTimezoneOptionsForCountry("GB").map((o) => o.value)).toEqual(["Europe/London"]);
  });

  it("US exposes exactly four timezone options, not just New York", () => {
    const values = getTimezoneOptionsForCountry("US").map((o) => o.value);
    expect(values).toEqual(["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"]);
  });

  it("returns an empty list for a country outside the launch catalog", () => {
    expect(getTimezoneOptionsForCountry("FR")).toEqual([]);
  });

  it("isSupportedTimezone is precise", () => {
    expect(isSupportedTimezone("Africa/Lagos")).toBe(true);
    expect(isSupportedTimezone("America/Chicago")).toBe(true);
    expect(isSupportedTimezone("Europe/Paris")).toBe(false);
    expect(isSupportedTimezone("africa/lagos")).toBe(false);
    expect(isSupportedTimezone("UTC+1")).toBe(false);
    expect(isSupportedTimezone("WAT")).toBe(false);
  });

  it("isTimezoneValidForCountry rejects a timezone outside that specific country's own options", () => {
    expect(isTimezoneValidForCountry("GB", "Europe/London")).toBe(true);
    // Africa/Lagos is a globally supported timezone, but not one of GB's
    // own selectable options.
    expect(isTimezoneValidForCountry("GB", "Africa/Lagos")).toBe(false);
    expect(isTimezoneValidForCountry("US", "America/Denver")).toBe(true);
    expect(isTimezoneValidForCountry("NG", "America/Denver")).toBe(false);
  });

  it("lists every supported timezone exactly once across all countries", () => {
    const all = listAllTimezoneOptions();
    expect(new Set(all.map((o) => o.value)).size).toBe(SUPPORTED_TIMEZONES.length);
    expect(all).toHaveLength(SUPPORTED_TIMEZONES.length);
  });
});
