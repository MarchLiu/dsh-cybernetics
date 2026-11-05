# llm-pi-ai `off` key corruption — diagnosis, validated fix, blocked apply

Date: 2026-11-04 17:44 (+08:00) · Target: `/Users/mars/.dsh/profiles/web/cordis.patch.yml`

## Status: FIX VALIDATED, NOT APPLIED (agent sandbox is workspace-write only)

The agent session cannot write outside `/Users/mars/jobs/dsh-cybernetics`:

```
$ touch /Users/mars/.dsh/profiles/web/.dsh-write-probe
touch: ...: Operation not permitted            # bash
write tool → [sandbox: file access denied under workspace-write mode]
```

Escalation is disabled in this session, so the one-line change must be applied by a
process that can write `~/.dsh/profiles/web/` (the user's terminal, or an agent run
with wider permissions). Everything needed is in this directory and validated.

## Root cause (confirmed by reproducing the schema failure)

`llm-pi-ai` rejects the whole providers block when a `reasoningEfforts` key is not one
of `off|minimal|low|medium|high|xhigh|max`
(`node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`: `THINKING_LEVELS`, and
`reasoningEfforts = z.dict(..., z.union(THINKING_LEVELS))` at ~line 1033).

Current file, lines 49 and 65 (`glm-5.3`, `glm-5.3-flash`) hold `false: null`
instead of `off: null`; the 17:28 backup holds `off:`. A YAML 1.1 round-trip is the
only thing that turns a bare `off` key into `false:`.

Reproduced against the profile's own schema:

```
$ node verify-cordis.mjs <current file>
"llmPiAi": {
  "ok": false,
  "error": ["$.providers.zai-coding-cn.models[6].reasoningEfforts expected false |
             { [key: \"off\" | \"minimal\" | ... ]: string | Schema<const> } but got
             {\"false\":null,\"minimal\":\"high\",...}"]
}
```

That rejection drops the llm-pi-ai row → `zai-coding-cn`/`kimi`/`ollama` are never
registered → the GUI only lists `deepseek-account`, and cybernetics'
`session.modelCatalog()` (lib/client.js `createModelCatalogStore`) returns
`{status:'error', options: []}`, so the model dropdown has nothing to show.

## The fix (two lines, no YAML round-trip)

`off-fix.diff` — exactly two changed lines, `false: null` → `"off": null`
(quoted, so no YAML 1.1 tool can re-corrupt it). Everything else byte-identical.

## Apply

```
cd /Users/mars/jobs/dsh-cybernetics/.fix-llm-pi-ai-20261104
./apply-fix.sh                  # minimal: only lines 49/65
./apply-fix.sh from-backup      # same meaning + restores the 74 comment lines
```

Both make a `cordis.patch.yml.bak-pre-offfix-<ts>` safety copy first, patch at text
level, then run the schema validation. `minimal` also refuses to run if the file
changed since diagnosis (sha guard).

## Verification (reproduced on a /tmp copy of the real file)

- `js-yaml 4.3.2` (YAML 1.2) and `yaml 2.9.1` both parse the patched file, 49 entries.
- `llm-pi-ai` `Config` accepts it; providers = `zai-coding-cn`, `kimi`, `ollama`
  (8 + 4 + 2 models); `glm-5.3`/`glm-5.3-flash` reasoningEffort keys are the six
  legal levels starting at `off`.
- Semantic diff as-found → fixed: exactly the two `reasoningEfforts` keys.
- Semantic diff 17:28 backup → fixed: only
  `agent-default-model` (provider/model/reasoningEffort) and `cybernetics.hardGate`.
  Nothing else drifted, including the `accountsYaml` / `serverPresets` values.
- `hardGate: true`, `allGoalsMode: true` and the three `zai-coding-cn/glm-5.3-flash`
  agent models survive in both variants.
- `from-backup` variant is semantically identical to `minimal` (0 diffs) and brings
  back 74 comment lines.

Full output: `verification.log`.

## Takes effect only after a restart

The profile patch layer is parsed at boot (`dsh-app-boot`); no file watcher was found
in `dsh/lib` or `cordis-plugin-loader/lib`, so an on-disk edit is not hot-reloaded
(only settings edited *through* the GUI go through `configEditor.reconcileProfilePatches`).
Restart the running `dsh web` process (pid 65486 on 127.0.0.1:3080). The agent did not
touch it.

## Side findings

1. **Comment loss (pre-existing).** The as-found file has 0 comment lines; the 17:28
   backup has 74. The earlier round-trip also re-serialised both block scalars
   (`accountsYaml`, `serverPresets`) into escaped double-quoted foldings. Values are
   provably unchanged (section "Verification"), only documentation/style was lost.
   `./apply-fix.sh from-backup` restores the comments; the minimal path leaves the
   file as-is apart from the two keys.
2. **`agent-default-model` = `deepseek-account` / `deepseek-flash` / `reasoningEffort: high`.**
   This is a real value change, not a serialization artefact: the round-trip cannot
   invent `reasoningEffort`. At 17:38:02 the file was rewritten; `configEditor.edit()`
   replaces exactly `[entry].config` with `{provider, model, reasoningEffort}` — the
   same field order now in the file — which is the GUI model picker's `saveSelection`
   payload. Conclusion: **user/GUI change** (most likely picking the only model still
   listed while the custom providers were unroutable), not an automatic failure
   fallback (a runtime fallback would never persist to the patch file). Left untouched.
3. **Emacs has the file open.** `.#cordis.patch.yml` (lock, 17:37) and
   `#cordis.patch.yml#` (auto-save, 17:38:26, same content but a different list
   indentation) exist. Close or revert that buffer before applying, or the next save
   will overwrite the fix.
