import { describe, expect, it } from "vitest";
import { encodeCursor, decodeCursor } from "./pagination";

describe("cursor pagination", () => {
  it("round-trips a valid cursor", () => {
    const cursor = { createdAt: "2026-08-26T00:00:00.000Z", id: "abc-123" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("returns null for undefined/empty input", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  it("returns null (never throws) for a malformed/tampered cursor", () => {
    expect(decodeCursor("not-base64url-json")).toBeNull();
    expect(decodeCursor(Buffer.from("{}").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ createdAt: 1 })).toString("base64url"))).toBeNull();
  });
});
