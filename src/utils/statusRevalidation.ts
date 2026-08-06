import { mutate } from 'swr';

/**
 * Revalidates every `/api/v1/status` SWR key, whatever its query string.
 *
 * A settings form that changes something requiring a restart has to tell
 * `StatusChecker` to re-check, or its "Server Restart Required" modal does not
 * appear until the next 60-second poll. The obvious `mutate('/api/v1/status')`
 * does not do that: `StatusChecker` subscribes to
 * `'/api/v1/status?checkUpdateAvailable=false'` and `VersionStatus` to
 * `` `/api/v1/status?checkUpdateAvailable=${versionCheck}` ``, and an SWR key is
 * matched by exact string. So the bare path revalidates a cache entry nothing is
 * watching, and every subscriber keeps its stale `restartRequired: false`.
 *
 * Hence a filter function rather than a key — it matches the path and every
 * variant of its query string, so adding another `/api/v1/status` consumer with
 * different params cannot silently reintroduce the bug.
 */
export const revalidateStatus = () =>
  mutate(
    (key) => typeof key === 'string' && key.startsWith('/api/v1/status'),
    undefined,
    { revalidate: true }
  );

export default revalidateStatus;
