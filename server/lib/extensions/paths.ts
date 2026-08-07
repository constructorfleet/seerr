import logger from '@server/logger';
import fs from 'fs/promises';
import path from 'path';

/**
 * Containment checks for paths that are about to be read from disk.
 *
 * The manifest schema already rejects absolute paths, `..` segments and Windows
 * separators (`relativeFilePath` in `manifest.ts`), and callers re-check with
 * `path.resolve` before reading. Neither of those sees a **symlink**: `resolve`
 * is pure string arithmetic, so a link at `<extension>/ui/panel.mjs` pointing at
 * `/etc/shadow` resolves to a path that is textually inside the extension
 * directory and is served anyway.
 *
 * Extension directories may themselves legitimately be symlinks — that is how
 * `examples/*` are developed against a checkout, and `discoverExtensions`
 * deliberately accepts them — so the root is resolved too and the comparison is
 * made between two real paths.
 */

/**
 * Whether `target` really lives inside `root` once every symlink on both paths is
 * resolved, or `false` if either path cannot be resolved at all.
 *
 * A missing `target` is not contained: callers are about to read it, and "does not
 * exist" and "exists outside the extension" both mean "do not serve this".
 */
export async function isContainedIn(
  target: string,
  root: string
): Promise<boolean> {
  const realRoot = await realpathOrUndefined(root);
  const realTarget = await realpathOrUndefined(target);

  if (!realRoot || !realTarget) {
    return false;
  }

  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
}

/**
 * The real path of `target` if it is inside `root`, otherwise `undefined` with a
 * log line naming the extension.
 *
 * Returns the resolved path rather than a boolean so a caller reads the file it
 * checked: re-deriving the path afterwards would reintroduce the symlink between
 * the check and the read.
 */
export async function containedPath({
  target,
  root,
  extensionId,
  what,
}: {
  target: string;
  root: string;
  extensionId: string;
  what: string;
}): Promise<string | undefined> {
  const contained = await isContainedIn(target, root);

  if (!contained) {
    logger.error(`Refusing ${what} outside the extension directory`, {
      label: 'Extensions',
      extensionId,
      target,
      root,
    });
    return undefined;
  }

  return fs.realpath(target);
}

async function realpathOrUndefined(
  target: string
): Promise<string | undefined> {
  try {
    return await fs.realpath(target);
  } catch {
    return undefined;
  }
}
