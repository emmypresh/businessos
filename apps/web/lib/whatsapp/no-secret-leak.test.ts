import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Static-analysis guard: every reference to a WhatsApp/Supabase secret
// env var anywhere in this application's source tree must live in a
// file that is either server-only (`import "server-only"`), a Next.js
// Route Handler (app/api/**/route.ts, which never ships to the
// browser), or a Server Action file (`"use server"`) — never a Client
// Component, and never anything importable from one. This mirrors this
// phase's own explicit "confirm client bundles do not contain the
// secrets" instruction with a fast, deterministic source-level check
// rather than a slow full production-bundle diff.

const SECRET_NAMES = [
  "META_WHATSAPP_ACCESS_TOKEN",
  "META_WHATSAPP_APP_SECRET",
  "META_WHATSAPP_VERIFY_TOKEN",
  "SUPABASE_SECRET_KEY",
];

const ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = ["lib", "app", "components"].map((d) => join(ROOT, d));

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      listFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("provider secret posture — no secret env var leaks into client-reachable code", () => {
  const files = SCAN_DIRS.flatMap((dir) => listFiles(dir));

  for (const secretName of SECRET_NAMES) {
    it(`every reference to ${secretName} is in a server-only, route-handler, or server-action file`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, "utf8");
        if (!content.includes(secretName)) continue;

        const isServerOnly = content.includes('"server-only"') || content.includes("'server-only'");
        const isServerAction = content.trimStart().startsWith('"use server"') || content.trimStart().startsWith("'use server'");
        const isRouteHandler = file.replace(/\\/g, "/").includes("/app/api/") && file.endsWith("route.ts");

        if (!isServerOnly && !isServerAction && !isRouteHandler) {
          offenders.push(file);
        }
      }
      expect(offenders).toEqual([]);
    });

    it(`${secretName} never appears with a NEXT_PUBLIC_ prefix`, () => {
      expect(SECRET_NAMES).not.toContain(`NEXT_PUBLIC_${secretName}`);
    });
  }

  it("no source file declares a NEXT_PUBLIC_ variant of any WhatsApp secret", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      if (/NEXT_PUBLIC_META_WHATSAPP/.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
