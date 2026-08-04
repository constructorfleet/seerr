import type { ExtensionRegistry } from '@server/lib/extensions/registry';
import type {
  ExtensionEvent,
  ExtensionEventMap,
} from '@server/lib/extensions/types';

/**
 * Where `sdk.events.on` listeners come from.
 *
 * A module-level source rather than a registry threaded through every emit site:
 * the emitters are TypeORM subscribers, which TypeORM constructs itself and hands
 * no dependencies to. Undefined until boot sets it, which makes
 * {@link emitExtensionEvent} a no-op with nothing installed — the correct
 * behaviour, and what keeps the subscribers testable without an extension in
 * scope.
 */
let source: ExtensionRegistry | undefined;

export function setExtensionEventSource(registry: ExtensionRegistry): void {
  source = registry;
}

/** For tests, so a source set by one file does not leak into the next. */
export function clearExtensionEventSource(): void {
  source = undefined;
}

/**
 * Re-emits a core transition to the extensions listening for it.
 *
 * Never rejects. Every call site is inside a core subscriber, in the middle of a
 * write core cares about, so an extension listener must not be able to turn a
 * successful save into a failed one — `ExtensionRegistry.emit` isolates each
 * listener, and an absent source is simply nothing to deliver to.
 */
export async function emitExtensionEvent<TEvent extends ExtensionEvent>(
  event: TEvent,
  payload: ExtensionEventMap[TEvent]
): Promise<void> {
  await source?.emit(event, payload);
}
