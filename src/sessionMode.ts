/**
 * Per-session cybernetics mode (v0.9.0): the durable `/cybernetics on|off|status`
 * override, its session projection, and the effective-mode resolution every
 * consumer (guidance section, hard gate, input-policy relay) shares.
 *
 * Pattern copied from @deepseek-ai/dsh-plan-mode: one append-only session log
 * event (`cybernetics/mode { enabled }`) folded by a registered session
 * projection, so the override survives resume and fork (both replay the log
 * prefix). `enabled: null` clears the override and falls the session back to
 * the profile-global `allGoalsMode` volatile configuration.
 *
 * Zero runtime dependencies: the projection definition is duck-typed exactly
 * like src/projection.ts (the host only ever calls `.parse` on the schemas).
 * @module dsh-cybernetics/sessionMode
 */

/** Session log event type carrying the per-session override. */
export const MODE_EVENT_TYPE = 'cybernetics/mode'

/** Projection registry key for the folded override state. */
export const MODE_PROJECTION_KEY = 'cyberneticsMode'

/** Wire/state shape of the projection: tri-state override, null = inherit global. */
export interface CyberneticsModeState {
  override: boolean | null
}

/** Duck-typed Zod stand-in (see src/projection.ts for the full rationale). */
interface SchemaLike<T> {
  parse(value: unknown): T
}

const passThrough = <T>(): SchemaLike<T> => ({ parse: (value) => value as T })

export interface ModeProjectionDefinitionLike {
  key: typeof MODE_PROJECTION_KEY
  stateSchema: SchemaLike<CyberneticsModeState>
  init(header: unknown, inheritedEventCount: number): CyberneticsModeState
  apply(state: CyberneticsModeState, event: { type: string; data?: unknown }): CyberneticsModeState
  wire: {
    viewSchema: SchemaLike<CyberneticsModeState>
    view(state: CyberneticsModeState): CyberneticsModeState
  }
  stateVersion: number
}

/**
 * The projection definition for `ctx.sessionProjections.register()`. Every
 * `cybernetics/mode` event is a whole-value write ({ enabled: true | false |
 * null }); last write wins — append-only history, no delta merge.
 */
export function cyberneticsModeProjection(): ModeProjectionDefinitionLike {
  return {
    key: MODE_PROJECTION_KEY,
    stateSchema: passThrough<CyberneticsModeState>(),
    init: () => ({ override: null }),
    apply(state, event) {
      if (event?.type !== MODE_EVENT_TYPE) return state
      const data = event.data as { enabled?: unknown } | undefined
      if (data === null || typeof data !== 'object') return state
      const enabled = data.enabled
      // Any value other than a strict boolean clears the override (null is the
      // documented "inherit global" sentinel; garbage heals to inherit too).
      const override = typeof enabled === 'boolean' ? enabled : null
      // A fresh object per owned event: the host republishes only when the
      // view reference changes (same convention as projection.ts).
      return { override }
    },
    wire: {
      viewSchema: passThrough<CyberneticsModeState>(),
      view: (state) => state,
    },
    stateVersion: 1,
  }
}

/** Minimal projection-registry face the resolution helper needs. */
interface ProjectionsLike {
  stateOf?(session: unknown, key: string): unknown
}

/**
 * Read the per-session override. Any failure (no registry, key not yet
 * replayed, malformed state) resolves to "no override" — the global
 * configuration decides, exactly like a fresh session.
 */
export function modeOverrideOf(ctx: unknown, session: unknown): boolean | null {
  if (session === undefined || session === null) return null
  const projections = (ctx as { sessionProjections?: ProjectionsLike })?.sessionProjections
  if (projections === undefined || typeof projections.stateOf !== 'function') return null
  try {
    const state = projections.stateOf(session, MODE_PROJECTION_KEY) as CyberneticsModeState | undefined
    if (state === undefined || state === null || typeof state !== 'object') return null
    return typeof state.override === 'boolean' ? state.override : null
  } catch {
    return null
  }
}

/**
 * Canonical tri-state join (v0.10.0): the session override wins; without one
 * the profile-global `allGoalsMode` volatile value decides. `source` names the
 * deciding side ('override' | 'global') so UI consumers (the session-header
 * pill in lib/client.js) can explain WHY a mode is effective without
 * duplicating the resolution rule.
 */
export interface ResolvedMode {
  enabled: boolean
  source: 'override' | 'global'
}

export function resolveMode(override: boolean | null, globalMode: boolean): ResolvedMode {
  return override === null
    ? { enabled: globalMode === true, source: 'global' }
    : { enabled: override, source: 'override' }
}

/**
 * Effective cybernetics enablement for one session: the per-session override
 * wins; without one the profile-global `allGoalsMode` volatile value decides.
 */
export function effectiveEnabled(ctx: unknown, session: unknown, allGoalsMode: boolean): boolean {
  return resolveMode(modeOverrideOf(ctx, session), allGoalsMode).enabled
}

/** The parsed slash-command argument → the event payload to append. */
export function modeEventPayload(arg: 'on' | 'off'): { enabled: boolean } {
  return { enabled: arg === 'on' }
}
