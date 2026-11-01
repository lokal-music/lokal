# Desktop parity for mobile issue #387

Issue: https://github.com/lokal-music/lokal-mobile/issues/387

- **Multi-artist duplicates:** Default All Sources view prefers desktop-owned recordings when matching an imported phone copy using track title, duration, album and album owner (album_artist when present, falling back to lead track artist). Complete credits are preserved in the stored track rows. Explicit Mobile view still shows the phone original.
- **Mix pages:** Home → Your Mixes title opens a local browser for that mix with track list, Back and Play. The cover remains quick-play; Save as playlist remains intact.
- **Phone → PC file target:** files received from paired phones now go beneath the existing user-configurable Download Location, in a 'Lokal Phone' subfolder rather than private application data. The Settings description identifies the behavior. Existing files are not moved or deleted; hashes and paired authentication still apply. The phone chooses its own reverse-transfer folder on Android.

The existing desktop endpoint /api/remote/library/lyrics continues exporting saved lyrics for mobile on-demand retrieval. No changes to credentials or audio format verification.

## Acceptance

1. Existing duplicate tests including alternate features, masters, and explicit mobile filters.
2. Select a different download drive in desktop Settings; send a new phone recording, verify it lands under <download root>/Lokal Phone with correct metadata, checksum and no duplicate.
3. Trigger identical phone upload; verify existing-original matching avoids unnecessary copying.
4. Open mix titles vs artwork, play tracks, navigate Back, and save the mix separately.
5. Verify the desktop remains a valid source for mobile streamed lyrics and artwork over paired authenticated endpoints.

Targeted Node tests: scripts/library-device-preference.test.mjs and scripts/storage-locations.test.mjs. They have been updated but not executed in this environment; do not infer passing CI or device/network behavior from static checks alone.
