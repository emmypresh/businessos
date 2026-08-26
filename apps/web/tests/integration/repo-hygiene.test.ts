import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("repo hygiene: businesses table write boundary", () => {
  it('never calls .from("businesses").insert( anywhere under app/ or lib/', () => {
    const root = path.resolve(__dirname, "../..");
    const files = [
      ...walk(path.join(root, "app")),
      ...walk(path.join(root, "lib")),
    ];

    const offenders = files.filter((file) =>
      /\.from\(\s*["']businesses["']\s*\)\s*\.insert\s*\(/.test(
        readFileSync(file, "utf8")
      )
    );

    expect(offenders).toEqual([]);
  });

  it("lib/business/actions.ts creates a business only via the create_business RPC", () => {
    const root = path.resolve(__dirname, "../..");
    const source = readFileSync(
      path.join(root, "lib/business/actions.ts"),
      "utf8"
    );
    expect(source).toMatch(/\.rpc\(\s*["']create_business["']/);
    expect(source).not.toMatch(
      /\.from\(\s*["']businesses["']\s*\)\s*\.insert\s*\(/
    );
  });
});
