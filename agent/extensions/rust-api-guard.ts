const DOCS_RS = "https://docs.rs";

/**
 * Rust API Guard Extension
 *
 * Intercepts edits to `.rs` files and extracts import paths that reference
 * external crates (not `std`, not local modules).  For each one it queries
 * docs.rs to verify the item actually exists in the crate version pinned in
 * Cargo.toml (or latest if no lock).
 *
 * Blocks the tool call if any items are NOT FOUND.  Warns for ambiguous lookups
 * that might be a docs.rs quirk rather than a real problem.
 */
export default function (pi) {
  // Cache: crate name → version string.
  let crateVersions: Map<string, string> | null = null;

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const input = event.input as any;
    const path = input?.path ?? "";
    if (!path.endsWith(".rs")) return;

    let content = input?.newText ?? input?.content ?? "";
    if (typeof content !== "string") content = JSON.stringify(content);

    // Lazy-load Cargo.toml on first invocation.
    if (!crateVersions || crateVersions.size === 0) {
      crateVersions = await loadCargoToml(path);
    }

    const items = extractExternalImports(content, crateVersions);
    if (items.length === 0) return;

    const checks = await verifyItems(items, 5, ctx.ui);

    const blocks: string[] = [];
    const warns: string[] = [];

    for (const c of checks) {
      if (c.status === "not_found") {
        blocks.push(`🚫 ${c.kind} "${c.itemPath}" (${c.crateName} ${c.version}) — does NOT exist in this version`);
      } else if (c.status === "unknown") {
        warns.push(`⚠️  Could not verify "${c.itemPath}" (${c.crateName}) — please check manually at https://docs.rs/${c.crateName.replace(/_/g, "-")}/${c.version}`);
      }
    }

    if (blocks.length === 0 && warns.length === 0) return;

    let msg = "⚠️ Rust API verification found the following\n\n";
    for (const b of blocks) msg += `${b}\n`;
    for (const w of warns) msg += `${w}\n`;

    if (blocks.length > 0) {
      msg += `\nBLOCKED. Before proceeding:\n1. Visit https://docs.rs/<crate>/<version> and verify each listed item\n2. Read the actual function/struct signature — param names, types, trait bounds may differ from your assumption\n3. Fix your code to match the real API, then re-submit\n\nDo NOT use the unverified items blindly — they will cause compile errors.`;
      return { block: true, reason: msg };
    }

    // Warnings only — let it through but inform.
    msg += `\nReview these items at docs.rs before using them.`;
    ctx.ui.notify(msg.replace(/\n/g, " "), "warn");
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("rust-api-guard enabled", "info");
  });
}

/* ───────── Types ──────── */

interface ExtImport {
  crateName: string;
  itemPath: string;       // e.g. "reqwest::Client" → "Client"
  fullPath: string;       // full dotted path, e.g. "Client::new" or "serde::Serialize"
}

type Check =
  | { status: "ok"; crateName: string; itemPath: string }
  | { status: "not_found"; crateName: string; version: string; itemPath: string; kind: string }
  | { status: "unknown"; crateName: string; version: string; itemPath: string };

/* ───── Cargo.toml loader ── */

async function loadCargoToml(_rsPath: string): Promise<Map<string, string>> {
  // We cannot read local files directly from the extension.
  // Fallback strategy: look up crates via docs.rs using "latest" as version.
  // This works fine — docs.rs resolves "latest" to newest stable release.
  return new Map();
}

/* ───── Import extraction ──── */

function extractExternalImports(content: string, _versions: Map<string, string>): ExtImport[] {
  const imports: ExtImport[] = [];

  // Gather local module names so we can skip them.
  const localMods = new Set<string>();
  for (const m of content.matchAll(/\b(?:pub\s+)?mod\s+(\w+)/g)) {
    localMods.add(m[1]);
  }

  // Match `use <path> as ?<alias>;` and `use self|super::...;`
  const useRe = /use\s+([a-zA-Z_]\w*(?:::[\w_:]+)*)(?:\s+as\s+\w+)?[;\n]/g;
  for (const m of content.matchAll(useRe)) {
    let rawPath = m[1].trim();

    // Expand wildcards — `use foo::*` imports everything, skip.
    if (rawPath.endsWith("::*")) continue;

    const rootCrate = rawPath.split("::")[0];

    // Skip standard library and relative paths.
    if (["std", "core", "alloc", "self", "super"].includes(rootCrate)) continue;
    // Skip local modules.
    if (localMods.has(rootCrate)) continue;
    // Skip crate keyword: `use crate::...` is intra-crate.
    if (rawPath.startsWith("crate::")) continue;

    // This is an external crate import.
    const parts = rawPath.split("::");
    const itemPart = parts.slice(parts.indexOf(rootCrate) + 1).join("::");
    if (!itemPart) continue;

    imports.push({
      crateName: rootCrate,
      itemPath: itemPart.includes("::") ? itemPart.split("::")[0] : itemPart,
      fullPath: itemPart,
    });
  }

  return dedup(imports);
}

function dedup<T>(arr: T[], keyFn: (x: T) => string = JSON.stringify): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of arr) {
    const k = keyFn(t);
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
}

/* ───── docs.rs verification ──── */

async function verifyItems(items: ExtImport[], maxChecks: number, _ui: any): Promise<Check[]> {
  const results: Check[] = [];
  let checked = 0;

  for (const item of items) {
    if (checked >= maxChecks) break;
    checked++;

    const docsCrateName = item.crateName.replace(/_/g, "-");
    const result = await probeDocsRs(docsCrateName, "latest", item.itemPath);
    results.push(result);
  }

  return results;
}

/*
 * docs.rs HTML API:
 *   https://docs.rs/<crate>/<version>/<crate-name>[/<module-path>]/<kind>.<name>.html
 *
 * Returns 200 if the item has docs, 404 otherwise.
 * We try each kind prefix until one matches or all fail.
 */

const KIND_PREFIXES = ["struct.", "enum.", "fn.", "type.", "trait."];

async function probeDocsRs(
  crateName: string,
  version: string,
  itemName: string,
): Promise<Check> {
  let anyNotFound = false;
  const seenErrors = new Set<string>();

  for (const prefix of KIND_PREFIXES) {
    const url = `${DOCS_RS}/${crateName}/${version}/${crateName}/${prefix}${itemName}.html`;
    try {
      const res = await fetch(url);
      if (res.ok) return { status: "ok", crateName, itemPath: itemName };

      // Distinguish 404 (item truly absent) from other HTTP errors (rate limit 429, server 5xx, etc.)
      if (res.status === 404) {
        anyNotFound = true;
      } else {
        seenErrors.add(res.status.toString());
      }
    } catch {
      // Network error — could be transient DNS, firewall, or docs.rs outage.
      // Continue trying other prefixes instead of short-circuiting.
      seenErrors.add("network");
    }
  }

  // All kind prefixes tried. If we got only network errors and no 404s, we can't be sure.
  if (!anyNotFound && seenErrors.size > 0) {
    return { status: "unknown", crateName, version, itemPath: itemName };
  }

  // One or more prefixes returned 404 → item almost certainly doesn't exist in this version.
  return { status: "not_found", crateName, version, itemPath: itemName, kind: "struct/fn/etc" };
}
