/**
 * The manifest as {@link import('./defineExtension').defineExtension} accepts
 * it: `ExtensionManifest`, deeply readonly.
 *
 * Separate from `ExtensionManifest` because `defineExtension` infers its
 * manifest with a `const` type parameter — that is what preserves
 * `store: true` as the literal `true` instead of widening it to `boolean`, and
 * without it there would be nothing to narrow on. `const` inference also makes
 * every array literal `readonly`, which a mutable `ExtensionManifestPermission[]`
 * would then reject.
 *
 * `ExtensionManifest` itself stays mutable so it keeps matching
 * `z.infer<typeof manifestSchema>` exactly, which is what
 * `conformance/hostContract.ts` compares.
 */
import type { ExtensionManifest } from './manifest';

type DeepReadonly<T> = T extends (infer TItem)[]
  ? readonly DeepReadonly<TItem>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type ExtensionManifestInput = DeepReadonly<ExtensionManifest>;
