const CRATES_API = "https://crates.io/api/v1/crates";

/**
 * Cargo Version Guard Extension
 *
 * Intercepts `cargo add <pkg>@<ver>` and direct Cargo.toml edits.
 * When a pinned version is behind the crates.io release, it **blocks** the
 * tool call and returns:
 *   - the stale vs. latest versions side-by-side
 *   - a link to the crate's CHANGELOG or repo so the agent can research
 *     API deltas before using the newer release
 *   - an explicit instruction NOT to proceed until it has verified
 *     compatibility
 */
export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const input = event.input as any;
      const command = (input?.command ?? "").replace(/^#!/, "");
      const result = await handleCargoAdd(command);
      if (result) return { block: true, reason: result };
    }

    if (event.toolName === "edit" || event.toolName === "write") {
      const input = event.input as any;
      const path = input?.path ?? "";
      let content = input?.newText ?? input?.content ?? "";
      if (typeof content !== "string") content = JSON.stringify(content);

      if (!isCargoTomlLike(path)) return;

      const staleDeps = await findStaleDepsInContent(
        content,
        event.toolName === "write"
      );
      if (staleDeps.length > 0) {
        return { block: true, reason: buildMultiBlockMessage(staleDeps) };
      }
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("cargo-version-guard enabled", "info");
  });
}

/* ───────── Core ──────────────── */

async function handleCargoAdd(command: string): Promise<string | null> {
  if (!command.includes("cargo")) return null;

  const tokens = tokenizeShell(command);
  const addIdx = tokens.findIndex((t) => t === "add");
  if (addIdx < 0 || addIdx + 1 >= tokens.length) return null;

  const rawPkg = tokens[addIdx + 1];
  if (rawPkg.startsWith("-")) return null;

  const parsed = parseCargoPkg(rawPkg);
  if (!parsed) return null;

  // No pinned version — cargo will grab latest anyway.
  if (!parsed.version || parsed.version === "*") return null;

  const info = await fetchCrateInfo(parsed.name);
  if (!info) return null;

  if (compareSemver(parsed.version, info.max_version) >= 0) return null;

  return buildSingleBlockMessage(
    parsed.name,
    parsed.version,
    info.max_version,
    info.repoUrl
  );
}

/* ───── crates.io queries ─────── */

interface CrateInfo {
  max_version: string;
  repoUrl?: string;
}

async function fetchCrateInfo(name: string): Promise<CrateInfo | null> {
  try {
    const res = await fetch(
      `${CRATES_API}/${encodeURIComponent(name)}`,
    );
    if (!res.ok) return null;
    const data: Record<string, any> = await res.json();
    return {
      max_version: data.max_version ?? "",
      repoUrl: (data.repository as string | undefined)?.replace(/\.git$/, ""),
    };
  } catch {
    return null;
  }
}

/* ───── Cargo.toml scanner ─────────────── */

type StaleDep = { name: string; current: string; latest: string; repoUrl?: string };

async function findStaleDepsInContent(
  content: string,
  fullFile: boolean
): Promise<StaleDep[]> {
  const lines = content.split("\n");
  const stale: StaleDep[] = [];
  let inDeps = false;

  for (const line of lines) {
    if (fullFile) {
      if (/^\s*\[.*dependencies.*\]/i.test(line)) inDeps = true;
      else if (/^\s*\[/.test(line)) inDeps = false;
      if (!inDeps) continue;
    }

    const dep = parseDepLine(line);
    if (!dep || !dep.version) continue;

    const info = await fetchCrateInfo(dep.name);
    if (!info) continue;

    if (compareSemver(dep.version, info.max_version) < 0) {
      stale.push({ name: dep.name, current: dep.version, latest: info.max_version, repoUrl: info.repoUrl });
    }
  }
  return stale;
}

/* ───── Block messages ──────── */

function buildSingleBlockMessage(
  name: string,
  current: string,
  latest: string,
  repoUrl?: string,
): string {
  const cratePage = `https://crates.io/crates/${name}#history`;
  const docsLink = `https://docs.rs/crate/${name}/latest`;

  let extra = "";
  if (repoUrl) {
    extra = `\n- Repository / changelog: ${repoUrl}`;
  }

  return `"cargo add ${name}@${current}" — this version is outdated.

The latest version of ${name} on crates.io is **${latest}** (you have ${current}).

Before upgrading, check for API changes that would break your code:
- Changelog / history: ${cratePage}${extra ? `\n${extra}` : ""}
- Latest API docs: ${docsLink}

Steps:
1. Read the changelog and verify nothing in your usage is broken
2. If APIs have changed, update your Rust source code accordingly
3. Then re-run with the corrected version: \`cargo add ${name}@${latest}\`

Do NOT proceed with the stale version or blindly use the new one without checking first.`;
}

function buildMultiBlockMessage(deps: StaleDep[]): string {
  const rows = deps.map((d) => {
    const repos = d.repoUrl ? ` (${d.repoUrl})` : "";
    return `- **${d.name}**: ${d.current} → ${d.latest}${repos}`;
  });

  return `"Cargo.toml" contains stale dependency versions:

${rows.join("\n")}

For EACH crate above you MUST:
1. Read the changelog at https://crates.io/crates/<name>#history and latest docs at https://docs.rs/crate/<name>/latest
2. Identify any breaking changes, renamed types, or deprecated functions that affect your code
3. Update your Rust source to match the new APIs if needed
4. Then re-write Cargo.toml with the corrected versions

Do not proceed with stale versions — they risk compile errors and subtle bugs from deprecated or removed APIs.`;
}

/* ───── Helpers ────────────── */

function isCargoTomlLike(path: string): boolean {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  return base === "cargo.toml" || /^Cargo\.toml\./.test(base);
}

function parseCargoPkg(raw: string): { name: string; version?: string } | null {
  const idx = raw.indexOf("@");
  if (idx < 0) return raw.length > 0 ? { name: raw } : null;
  const name = raw.slice(0, idx);
  const version = raw.slice(idx + 1);
  if (!name || version === "") return null;
  return { name, version };
}

function compareSemver(a: string, b: string): number {
  const aParts = sanitizeVer(a).split(".").map(Number);
  const bParts = sanitizeVer(b).split(".").map(Number);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av === bv) continue;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function sanitizeVer(v: string): string {
  return v.replace(/^[~^>=v<]+/, "");
}

function parseDepLine(line: string): { name: string; version?: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) return null;

  const eqIdx = trimmed.indexOf("=");
  if (eqIdx < 0) return null;

  const name = trimmed.slice(0, eqIdx).trim().replace(/"/g, "");
  const rest = trimmed.slice(eqIdx + 1).trim();

  // Skip path / git deps — they don't have crates.io versions.
  if (rest.includes("path =") || rest.includes("git =")) return null;
  if (!rest || rest === "\"\"") return { name };

  // Inline table: { version = "1.0" ... }
  if (rest.startsWith("{")) {
    const m = rest.match(/version\s*=\s*"([^"]+)"/);
    if (m) return { name, version: m[1] };
    return null;
  }

  // Quoted version: "1.0.150"
  const m2 = rest.match(/^"([^"]+)"/);
  if (m2) return { name, version: m2[1] };

  return null;
}

function tokenizeShell(str: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;

  for (const ch of str) {
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === " " && !inSingle && !inDouble) {
      if (cur) { tokens.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}
