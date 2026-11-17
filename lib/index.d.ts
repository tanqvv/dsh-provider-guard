import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name. */
export declare const name: 'provider-guard'

/**
 * Install the provider-affinity policy.
 *
 * @param ctx - host context.
 * @param config - provider-guard configuration; see README.md.
 */
export declare function apply(ctx: Context, config: unknown): void
