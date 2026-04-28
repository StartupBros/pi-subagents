# StartupBros sync notes

Last updated: 2026-04-28

## Baseline

This branch is a Pi-first resync of `pi-subagents` onto upstream `nicobailon/pi-subagents` v0.20.1.

- Upstream remote: `upstream` (`git@github.com:nicobailon/pi-subagents.git`)
- Upstream baseline: `upstream/main` / tag `v0.20.1` (`b91c881`)
- StartupBros previous fork head: `origin/main` (`fbae537`)
- Current sync branch: `resync-upstream-v0.20.1`

The merge commit intentionally records `origin/main` as superseded after replaying the local behavior we still need on top of upstream v0.20.1. Future resyncs should diff against upstream first, then re-apply only the local deltas listed below.

## Local deltas to preserve

Keep these changes unless upstream grows equivalent behavior:

1. Configurable manager command
   - Config key: `managerCommand`
   - Default: `"agents"`
   - Leading slashes are normalized (`"/subagents"` -> `"subagents"`)
   - `false` disables the manager slash command while keeping keyboard access
   - Local machine config uses `"subagents"` to avoid the `/agents` collision with `pi-side-agents`

2. Runtime HOME-safe intercom defaults
   - Intercom default paths are resolved through functions instead of module-load constants
   - This keeps tests and alternate runtime homes from accidentally binding to the developer's real home directory

3. Direct TypeScript import compatibility
   - Local imports use `.ts` where Pi's package health/runtime loader expects the source extension
   - `doctor_packages` must keep passing for live dogfooding

## Verification checklist

Run these after every resync:

```bash
cd /home/will/SITES/pi-subagents
npm run test:all
node --experimental-strip-types --input-type=module -e "import('./index.ts').then(() => console.log('index import ok'))"
```

Then from any Pi session using the local path package:

```bash
# Confirm local Pi config points at this repo and renames the manager command
python3 - <<'PY'
import json, pathlib
settings = json.loads(pathlib.Path('/home/will/.pi/agent/settings.json').read_text())
config = json.loads(pathlib.Path('/home/will/.pi/agent/extensions/subagent/config.json').read_text())
assert '/home/will/SITES/pi-subagents' in settings.get('packages', [])
assert config.get('managerCommand') == 'subagents'
print('local Pi subagents config ok')
PY
```

Also run Pi package health:

```bash
# Via Pi tool/harness: doctor_packages(fix=false)
```

Expected result: package health passes and the local setup exposes `/subagents` for the manager instead of `/agents`.

## Manual smoke tests

Use an interactive Pi session after restarting Pi so the edited package is reloaded:

- `/subagents` opens the Agents Manager overlay
- `/agents` is left available for `pi-side-agents`
- `Ctrl+Shift+A` still opens the Agents Manager overlay
- `subagent` tool list/status/doctor actions still work

## Upstreamable follow-ups

Good candidates to upstream as small PRs:

- `managerCommand` config support, because slash command collisions are likely in multi-extension installs
- Runtime HOME-safe intercom default path resolution, because it improves test isolation and portability
- Any `.ts` source-import compatibility fixes that match upstream's package/runtime expectations
