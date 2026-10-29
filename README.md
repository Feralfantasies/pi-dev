# ~/.pi Configuration Repository

Version-controlled configuration for [pi](https://github.com/earendil-works/pi-coding-agent), an agentic coding assistant. This repo lets me track config changes and recreate the environment from scratch when needed.

## Directory Layout

```
~/.pi/
├── .gitignore                      # Excludes binaries, sessions, modules
├── agent/
│   ├── AGENTS.md                   # Project instructions (system prompt hints)
│   ├── auth.json                   # Auth credentials (NOT tracked)
│   ├── bin/                        # Vendored binaries: fd, rg (NOT tracked)
│   ├── extensions/                 # Custom TypeScript extensions
│   │   ├── cargo-version-guard.ts
│   │   ├── rust-api-guard.ts
│   │   └── search.json             # Search backend config
│   ├── models.json                 # LLM provider + model definitions
│   ├── npm/                        # Extension packages (npm)
│   │   ├── package.json
│   │   ├── package-lock.json
│   │   └── node_modules/           # (NOT tracked)
│   ├── sessions/                   # Chat session logs (NOT tracked)
│   └── settings.json               # User preferences
└── README.md                       # This file
```

## Extensions Installed

### npm Packages (`agent/npm/package.json`)

| Package | Version | Purpose |
|---------|---------|---------|
| `lsp-pi` | ^1.0.5 | LSP navigation — definitions, references, diagnostics, hover info |
| `pi-search-hub` | ^2.1.0 | Web search backends (DuckDuckGo, Serper, Brave, etc.) |
| `pi-lens` | ^3.8.47 | AST-aware code search + static analysis (ast-grep rules) |
| `pi-goal-x` | ^0.18.5 | Goal tracking and structured task workflows |
| `pi-turnlog` | ^0.1.2 | Session provenance / durable handoff records |
| `@latent-variable/pi-auto-continue` | ^0.1.0 | Automatic continuation prompts |

### Custom TS Extensions (`agent/extensions/`)

| File | Purpose |
|------|---------|
| `cargo-version-guard.ts` | Intercepts `cargo add` and Cargo.toml edits. Blocks the call if a pinned crate version is behind the latest crates.io release, prompting the agent to check CHANGELOGs before upgrading. |
| `rust-api-guard.ts` | Intercepts writes to `.rs` files. Extracts import paths for external crates and queries **docs.rs** to verify the items exist at the pinned version. Blocks on `NOT FOUND`, warns on ambiguous lookups. |
| `search.json` | Configures `pi-search-hub` backends. Currently uses a local **SearXNG** instance at `192.168.1.20:30601`. |

## Model Configuration

See `agent/models.json`. Configured with a **llama.cpp** provider (llama01 at `192.168.1.50:8000/v1`, OpenAI-compatible API) with:

- `Qwen3.8-27B` (Q4_K_M, 65K context) — default model

## How to Recreate the Environment

On a fresh machine (or after wiping `~/.pi`):

```bash
# 1. Clone the repo
git clone <repo-url> ~/.pi

# 2. Install pi itself (if not already installed)
npm install -g @earendil-works/pi-coding-agent

# 3. Install extension packages
cd ~/.pi/agent/npm
npm ci          # uses package-lock.json for reproducible installs

# 4. Restore auth if needed
#    - Copy API keys / tokens into agent/auth.json manually
#    - Or let pi re-authenticate when it first connects to providers

# 5. Restart pi — it will pick up all config, models, and extensions automatically
```

### Notes

- **Binaries** (`fd`, `rg` in `agent/bin/`) are vendored by pi and will be re-downloaded on the next update — they are intentionally not tracked.
- **Session logs** grow continuously and are excluded. If you need to preserve conversation history, back them up separately.
- **auth.json** is ignored by git for security. Re-enter any API keys or credentials manually after restoring.

## Updating Extensions

```bash
cd ~/.pi/agent/npm
npm update                    # update all packages within semver ranges
# or:
npm install <package>@latest  # update a specific package
git add package.json package-lock.json
git commit -m "update extensions"
```
