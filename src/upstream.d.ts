/**
 * Minimal ambient declarations for the DSH host packages this plugin is
 * `link:`-mounted against.
 *
 * Rationale: the plugin is deliberately zero-dependency (see src/index.ts), so
 * `npx tsc --noEmit` in this checkout has no node_modules to resolve the host
 * packages from. The only upstream surfaces the plugin needs to merge into are
 * the two merge-extensible type tables below (their real declarations in
 * @deepseek-ai/dsh-session-projection / @deepseek-ai/dsh-session are exactly
 * these empty interfaces). Declaring them ambiently keeps the augmentation in
 * src/projection.ts a valid augmentation instead of a TS2664 error, and keeps
 * the standalone typecheck at its pre-existing baseline (only the known
 * TS2307/TS5097 diagnostics from the type-only imports).
 */
declare module '@deepseek-ai/dsh-session-projection/types' {
  export interface SessionProjectionMap {}
  export interface SessionProjectionStateMap {}
}

declare module '@deepseek-ai/dsh-session/types' {
  export interface SessionEventMap {}
}
