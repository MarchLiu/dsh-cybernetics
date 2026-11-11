/**
 * Per-session preset-plan role override (v0.25.5, user ruling 2026-11-11):
 * the durable-free `/cybernetics use <id>` target. Unlike the settings-card
 * dropdown path (which writes the six global role fields through the settings
 * service), `use` resolves a plan (built-in PRESET_IDS id or `custom:<id>`,
 * or auto via the preset_recommend tool) into task/verify/triage
 * {provider, model, reasoningEffort} picks and stores them HERE — an
 * in-memory, per-session map. Zero settings.mutate calls anywhere on the use
 * path: the host's write-gate defect (docs/CHANGELOG.md v0.7.10, dsh-app-boot
 * dual-module instance → WeakMap miss) becomes irrelevant for `use`, and the
 * global configuration is never touched.
 *
 * Lifecycle: the map lives in module scope of the plugin entry — it is not
 * persisted anywhere and dies with the host process, i.e. exactly the
 * "session-only" semantics the ruling requires (a session restart falls back
 * to the global fields). `use off` (or the status line's instruction) clears
 * the override and the session falls back to the global fields immediately.
 *
 * Resolution rule consumed by the round-dispatch read point (src/index.ts,
 * where the flat taskAgentModel/… fields fold into `roles`): SESSION OVERRIDE
 * > GLOBAL FIELDS. Uncovered roles and uncovered fields fall through to the
 * global value / session-agent inheritance, so a session without `use`
 * behaves byte-for-byte as before.
 *
 * @module dsh-cybernetics/sessionRoles
 */

/** One role's override spec (same shape as RolesConfig rows). */
export interface SessionRoleSpec {
  provider?: string
  model?: string
  reasoningEffort?: string
}

/** What `use <id>` stores for one session. */
export interface SessionRolesOverride {
  preset: string
  label: string
  roles: Partial<Record<'task' | 'verify' | 'triage', SessionRoleSpec>>
  appliedAt: string
}

/** Canonical session key: the session log id, falling back to the agent id. */
export function sessionRolesKeyOf(agent: unknown): string | undefined {
  const a = agent as { session?: { header?: { id?: unknown } }; id?: unknown } | undefined
  const id = a?.session?.header?.id
  if (typeof id === 'string' && id.length > 0) return id
  if (typeof a?.id === 'string' && a.id.length > 0) return a.id
  return undefined
}

const store = new Map<string, SessionRolesOverride>()
/** Sessions with a pending `use auto` handoff (the tool's second hop lands here). */
const autoPending = new Map<string, string>()

/** Record (or replace — repeated `use` switches) the override for one session. */
export function setSessionRolesOverride(key: string | undefined, override: SessionRolesOverride): void {
  if (key === undefined) return
  store.set(key, override)
}

/** Read the override; undefined = no override, the session follows global. */
export function getSessionRolesOverride(key: string | undefined): SessionRolesOverride | undefined {
  if (key === undefined) return undefined
  return store.get(key)
}

/** Clear the override; the session returns to the global fields. */
export function clearSessionRolesOverride(key: string | undefined): boolean {
  if (key === undefined) return false
  autoPending.delete(key)
  return store.delete(key)
}

/** Mark a session as waiting for the `use auto` recommendation (tool hop 2). */
export function setSessionAutoPending(key: string | undefined, preset = 'auto'): void {
  autoPending.set(key!, preset)
}

/** Whether this session's preset_recommend hop 2 must land as a session override. */
export function takeSessionAutoPending(key: string | undefined): boolean {
  if (key === undefined) return false
  const pending = autoPending.get(key)
  if (pending === undefined) return false
  autoPending.delete(key)
  return true
}

/** Non-consuming check (status rendering). */
export function peekSessionAutoPending(key: string | undefined): boolean {
  if (key === undefined) return false
  return autoPending.has(key)
}

/**
 * The pure merge the round-dispatch read point applies AFTER folding the
 * global fields: session override rows win per role, per field — a role the
 * override does not mention, and fields the row does not set, keep the global
 * (or inherited) value. Returns a NEW object; inputs are never mutated.
 */
export function mergeSessionRolesOverride(
  roles: Record<string, SessionRoleSpec | undefined>,
  override: SessionRolesOverride | undefined,
): Record<string, SessionRoleSpec | undefined> {
  if (override === undefined) return roles
  const merged: Record<string, SessionRoleSpec | undefined> = { ...roles }
  // The override's task role maps onto the canonical 'default' dispatch key.
  const pairs: Array<['default' | 'verify' | 'triage', SessionRoleSpec | undefined]> = [
    ['default', override.roles.task],
    ['verify', override.roles.verify],
    ['triage', override.roles.triage],
  ]
  for (const [key, spec] of pairs) {
    if (!spec) continue
    merged[key] = { ...merged[key], ...spec }
  }
  return merged
}

/** Render the override's picks as `task=a/b(effort), …` for receipts/status. */
export function formatSessionRolesOverride(override: SessionRolesOverride): string {
  return (['task', 'verify', 'triage'] as const)
    .map((roleKey) => {
      const spec = override.roles[roleKey]
      if (!spec) return `${roleKey}=（未指定，跟随全局）`
      const target = [spec.provider, spec.model].filter(Boolean).join('/') || '（未指定）'
      return spec.reasoningEffort ? `${roleKey}=${target}(${spec.reasoningEffort})` : `${roleKey}=${target}`
    })
    .join(' ')
}
