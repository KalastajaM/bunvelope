# Bunvelope desktop (optional)

An Electron distribution of the existing **local-folder** application. It shares
`index.html`, `js/`, `css/`, fonts and the example budget at build time. There is no
fork of the UI or budgeting engine, and no Express, Postgres, localhost server,
general filesystem bridge or Node access in the renderer. A sandboxed preload
exposes only API-key storage and bounded price lookup capabilities. The cloud
and browser-local apps continue to run with the root package alone.

This is the first desktop milestone, not a signed public release. Mac/Windows
installer and updater configuration is included. Signing credentials, a public
update feed and native install/upgrade acceptance remain release prerequisites.

## Run from a checkout

Install a supported Node release (22 or newer recommended), then from the repo:

```sh
npm ci --prefix desktop
npm --prefix desktop start
```

End users of a packaged application do not need Node or any other runtime.
Use **Open folder…** to create/open a budget, or **Continue as guest** to try the
included example. The folder stays in its chosen location, outside the installed
application. Existing browser-local JSON folders are compatible. Don't edit the
same folder concurrently in a browser, CLI or another application: the existing
write-sequence check detects stale data but isn't a cross-process filesystem lock.

Electron uses Chromium's native File System Access API. Reusing the existing
adapter preserves its validation, journal recovery, migration backups, save queue
and IndexedDB recent-folder list. Directory capabilities come from the native
picker, a user drop or a previously stored handle; the renderer cannot manufacture
a handle from a path. Other origins/permissions and protected-directory overrides
are denied. Navigation is restricted to the bundled app; new windows are denied.

Preferences and recent-folder handles live under Electron's app-data directory:

- macOS: `~/Library/Application Support/Bunvelope`
- Windows: `%APPDATA%/Bunvelope`
- Linux (development smoke): `$XDG_CONFIG_HOME/Bunvelope`, normally `~/.config/Bunvelope`

Keep `com.bunvelope.desktop`, this profile location and `bunvelope://app` stable
across releases. Installing a new version replaces application files, not budgets
or preferences. The Windows uninstaller also preserves app data.

The app inherits local mode's feature set. Its existing direct Anthropic transport
and consent flow remain available, but live AI calls have not been validated in
this shell. Local API keys use Electron safeStorage: OS-backed encryption (Keychain on macOS,
DPAPI on Windows) protects the encrypted file in the app-data directory. The key
is decrypted into renderer memory for the existing direct Anthropic transport;
this protects storage at rest, not compromised application code. Saving is refused
when encryption is unavailable (including Linux basic_text). A legacy profile key
is removed only after secure storage succeeds. No key is written into a budget.

Desktop price lookups use the same service module as cloud: Yahoo ticker/ISIN
resolution, supported Danske/FT URLs, and base-currency conversion. The bridge
accepts only these operations from the app's main frame, with bounded inputs and
rate/concurrency limits; redirects retain the host allowlist. No HTTP listener,
cloud account or database is required.

## Build

Run on the corresponding OS:

```sh
npm --prefix desktop run dist -- --mac --arm64
npm --prefix desktop run dist -- --mac --x64
npm --prefix desktop run dist -- --win --x64
```

Outputs go to `desktop/dist/`: macOS DMG + ZIP, Windows NSIS installer. For a quick
unpacked build use `npm --prefix desktop run pack`. Linux unpacked builds are for
automated development testing, not a supported Linux release commitment.

`.github/workflows/desktop.yml` builds unsigned Mac ARM64, Mac Intel and Windows
x64 test installers on desktop-related PRs or manual dispatch. They are private CI
artifacts, not public releases. The workflow doesn't need signing secrets and
never uploads an update feed. Unsigned builds may require OS security overrides
and are not suitable for general distribution. App-specific installer icons and
branding are still release polish.

## Dependency override

The lockfile scopes `global-agent` 4.1.3 to `@electron/get`. The downloader's
3.x dependency otherwise pulls `roarr` 2.x and the unpatched `sprintf-js`
precision-specifier advisory (GHSA-hp3w-g68c-fv3c). Version 4 retains the
`bootstrap()` API used by that downloader and removes the vulnerable logging
chain. Electron and electron-builder remain pinned at their existing versions.
Remove the override when the upstream downloader no longer needs it, after
running desktop tests, proxy-download coverage, smoke, packaging and audit.

## Updates and signing

Manual upgrades work by installing the newer package over the old one. In-app
**Help → Check for updates…** is implemented with `electron-updater`, but disabled
unless a feed is configured at build time. There are no background checks,
downloads or install-on-quit behavior. The user approves download and installation
separately. Installation first closes the window normally; the existing
`beforeunload` save guard can veto it. Retry the menu after saves finish.

For a distributable update-enabled build:

1. Increment `desktop/package.json` and its lockfile together. Desktop versions
   are independent of the root package's `0.0.0`.
2. Configure Apple Developer ID signing and notarization on the macOS release
   runner, and Windows code signing on the Windows runner. Electron-builder
   accepts signing configuration through its documented environment variables
   (for example `CSC_LINK` / `CSC_KEY_PASSWORD`; Apple notarization credentials
   must also be supplied). Never commit credentials.
3. Set `BUNVELOPE_UPDATE_URL` to a public HTTPS artifact directory at **build**
   time. Use a separate feed directory per OS/architecture to avoid separately
   built macOS manifests overwriting one another. The builder rejects URLs with
   credentials, queries or fragments and requires code signing for these builds.
   For Windows also set `BUNVELOPE_WINDOWS_PUBLISHER` to the certificate publisher;
   the updater verifies that publisher. Don't embed private GitHub access tokens.
4. Run `dist` on the native runner. The build stays `--publish never`: inspect
   and validate the outputs before uploading. Verify macOS notarization/Gatekeeper
   acceptance and Windows signatures; `forceCodeSigning` alone does not prove
   notarization or SmartScreen reputation.
5. Upload installers, macOS ZIPs, blockmaps and the generated update metadata to
   the corresponding feed. Upload metadata **last**, once its referenced assets
   are available. Retain the previous release for recovery.
6. Test an installed older version checking, downloading, declining, accepting
   and completing the update on every supported OS/architecture.

No feed or signing identity is configured in this repository. End-to-end signed
updates have not been verified yet. Update notifications/download failures don't
prevent offline budgeting.

Application rollback is separate from data rollback. Before every older-schema
budget migration, the shared local adapter writes all six budget files exactly as
read to a unique `backup-v…` subfolder, records absent files, and verifies SHA-256
fingerprints. The completion manifest is written last. Backup failure aborts the
migration; these backups are not created on ordinary saves or app-only upgrades.

Automatic hourly backups to a user-selected folder are also available in
**Settings → Data & Security**. They run while the app is open, retain dated
recovery points, and show failures in the status bar. A synced folder provides
an off-device copy only after the sync client uploads it. See
[backup settings, retention and recovery](../docs/backups.md#automatic-folder-backups-browser-and-desktop).

To restore, open **Settings → Data & Security → Select backup…**, choose
the completed backup folder, then **Restore to empty folder…**. All fingerprints
are checked before writing. The destination must be empty, and the source budget
and backup stay unchanged. A failed restore is marked incomplete and cannot be
opened as a budget; retry into another empty folder. Use a compatible older app
for rollback: opening restored data in the current app will migrate it again.
Older partial backups without a completion manifest require manual recovery.
The snapshot covers the six canonical budget files, not arbitrary attachments or
OS profile preferences. Cross-process filesystem locking remains unsupported.

## Checks and acceptance

With root development dependencies installed (`npm ci`):

```sh
npm --prefix desktop run lint
npm --prefix desktop test
npm --prefix desktop run test:smoke
npm run lint
npm run typecheck
npm test
npx playwright test --project=static
```

The Electron smoke test uses a disposable profile and real temporary disk folder.
Chromium's native drag/drop capability supplies the folder handle; the shared
adapter saves it, IndexedDB remembers it, a reload reads it back, and a pending
save source blocks closing. It also loads the example-budget UI and captures
`desktop/artifacts/desktop.png`. No fake storage adapter or production budgets
are used. On headless Linux run inside Xvfb; only if the CI container cannot use
Chromium sandboxing, set `BUNVELOPE_TEST_NO_SANDBOX=1` for this test. Production
launches never disable the sandbox.

Native release acceptance is still required: actual folder picker and cancelled
selection, fresh/legacy/newer-schema budgets, disk-full/write-denied recovery,
close and quit during saves, exports/imports, retained recent budgets after an
application restart/upgrade, signed installer acceptance, update failure and
recovery. Do this on Mac ARM64/Intel and Windows x64. The smoke test does not
claim to exercise the native folder-picker UI or a signed installer.

## Remove the desktop experiment

Delete `desktop/` and `.github/workflows/desktop.yml`. Optionally remove the
`desktop/**` lint exclusion from root `eslint.config.js` and this README's link
from the root README. No shared application source, storage facade, server,
database schema, root runtime dependency or budget format needs changing.
