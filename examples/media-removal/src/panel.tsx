/**
 * The Removal Requests panel — **a placeholder**.
 *
 * This slice is the server half of the extension: the entity, the migration, the
 * route table and the removal execution. The panel that drives those routes is the
 * next slice, and this file exists so that the manifest's `provides.panels` entry
 * names a bundle that is actually on disk. A declared panel whose bundle is
 * missing fails at `import()` in the browser with nothing on the server to explain
 * it, so shipping the manifest entry without the file would be worse than
 * shipping this.
 *
 * What the next slice fills in, using the routes already there:
 * `GET /requests` (own rows, or everyone's with `manage`), `POST /requests`,
 * `POST /requests/:id/approve|decline`, `DELETE /requests/:id`, and
 * `GET`/`POST /settings` for the auto-approval switch — which, per `index.ts`, is
 * reachable *only* from here, because core's settings screen cannot host it.
 *
 * The two hard constraints on any panel, which this file already satisfies and the
 * next slice must keep:
 *
 * - **It default-exports a component taking a single `sdk` prop.** The host reads
 *   `mod.default` and renders `<PanelComponent sdk={sdk} />`.
 * - **Its only bare imports are ones the host's import map provides** — `react`,
 *   `react/jsx-runtime`, `react-intl`, `swr`, listed in
 *   `server/lib/extensions/sharedModuleSpecifiers.ts`. An unmapped specifier does
 *   not fail loudly; it resolves to a *second copy* of the package, which renders
 *   correctly and then throws on the first hook. Note there is no `axios` entry —
 *   which is why the SDK hands over a pre-scoped `api` instance instead.
 */

/**
 * The panel SDK, re-declared rather than imported.
 *
 * `@app/components/ExtensionPanel/sdk` is host source and not part of this
 * extension's build. Only the members this panel touches are declared; the object
 * it receives has more.
 */
interface PanelSdk {
  user: { id: number; displayName?: string };
  hasPermission: (permission: string | string[]) => boolean;
}

const RemovalRequestsPanel = ({ sdk }: { sdk: PanelSdk }) => (
  <div className="mt-6">
    <div className="mb-6">
      <h3 className="heading">Removal Requests</h3>
      <p className="description">
        {sdk.hasPermission('manage')
          ? 'Review requests to delete media, and choose whether unavailable media is removed without review.'
          : 'Ask for media you requested to be deleted, and see what you have asked for.'}
      </p>
    </div>
    <p className="text-sm text-gray-400">
      This panel is not built yet. The server side is complete — see this
      extension&rsquo;s routes under <code>/api/v1/ext/media-removal</code>.
    </p>
  </div>
);

export default RemovalRequestsPanel;
