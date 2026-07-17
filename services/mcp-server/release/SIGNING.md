# Signing & Notarization Runbook (Task 3)

This runbook covers code-signing the wrapped `xberg-mcp` binaries produced by
`build.yml` / `release.yml`. It is authored to be **safe to commit without any
secrets** — every signing step in `.github/workflows/sign.yml` is gated behind an
`if: ${{ secrets.X != '' }}` guard, so the workflow is a no-op until the
corresponding GitHub encrypted secret is populated.

## Secrets

| Secret | Platform | Purpose |
| --- | --- | --- |
| `WINDOWS_CODESIGN_P12` | Windows | Base64 of the Authenticode `.p12` (PKCS#12) cert + key. |
| `WINDOWS_CODESIGN_PASSWORD` | Windows | Password for the P12 above. |
| `APPLE_CERT_P12` | macOS | Base64 of the Developer ID Application `.p12`. |
| `APPLE_CERT_PASSWORD` | macOS | Password for the Apple P12. |
| `APPLE_NOTARY_KEY` | macOS | Base64 of the App Store Connect API key `.p8`. |
| `APPLE_NOTARY_KEY_ID` | macOS | Key ID of the notary API key. |
| `APPLE_TEAM_ID` | macOS | Apple Developer Team ID (used as issuer + signing identity). |
| `LINUX_GPG_KEY` | Linux | Base64 of the ASCII-armored GPG private key for detached signing. |

All secrets are **base64-encoded** before storage. `sign.yml` decodes them at
runtime (`base64 -d`); never store raw keys.

## Pipeline

1. `build.yml` produces `xberg-mcp-windows.exe`, `xberg-mcp-linux`, `xberg-mcp-darwin`.
2. `sign.yml` runs (via `workflow_dispatch` or `workflow_call` from `release.yml`):
   - **Windows** — `osslsigncode` Authenticode sign with a DigiCert RFC-3161 timestamp.
   - **macOS** — `codesign --options runtime --timestamp` then `xcrun notarytool submit --wait` and `xcrun stapler staple`.
   - **Linux** — `gpg --detach-sign --armor` produces `xberg-mcp-linux.asc`.
3. Signed artifacts re-uploaded as `signed-binaries` and consumed by `release.yml`.

## Rotation

- Rotate Authenticode/Apple certs **before** expiry (track in calendar; Apple
  Developer ID certs last ~5 years, Authenticode ~1–3 years).
- Revoke and re-key a cert immediately if compromise is suspected. Update the
  GitHub secret; no code change needed.
- GPG key rotation: generate a new key, sign the new public key into the web-of-trust,
  publish the new public key in release notes, and update `LINUX_GPG_KEY`.

## Safety rules

- **Never log private keys.** Secrets are never `echo`'d; decoding happens inline into
  a temp file that is cleaned by the runner.
- Minimize secret exposure: decode only within the guarded step that needs it.
- Timestamps (RFC-3161 / `--timestamp`) keep signatures valid past cert expiry.
- Verify locally before publishing: `osslsigncode verify`, `codesign --verify --verbose`,
  `gpg --verify xberg-mcp-linux.asc xberg-mcp-linux`.
