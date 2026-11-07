# Durable phone uploads, protocol 1

A disconnected HTTP reply does not prove an audio upload failed. Protocol 1
records the upload's immutable intent and outcome in the same SQLite transaction
as the playable desktop track. The operation belongs to the authenticated remote
device and active desktop account. Other devices cannot inspect its outcome.

## Negotiation and requests

An authenticated `GET /api/remote/files` advertises `uploadOperations: 1` only
when its storage, schema and FULL SQLite durability checks pass. The bounded
`GET /api/remote/files/operations` returns `{protocolVersion:1,uploadOperations}`
without returning the library listing. A phone must
persist which protocol it actually used. An old upload without an operation
header cannot safely be recovered by querying a newly generated operation key.

`POST /api/remote/files` keeps the existing raw audio body and metadata header.
Protocol 1 adds `x-link-upload-version: 1` and `x-link-upload-id`, a lowercase
canonical UUID. `Content-Length` and lowercase SHA-256 in `x-link-metadata` are
mandatory. The body is bounded at 1 GiB and is counted, hashed and parsed as audio.
Metadata is base64url UTF-8 JSON with only `title`, `artist`, optional `album`,
`extension`, optional `originalFilename`, and `sha256`. Header metadata is bounded
at 8192 decoded bytes and string fields at 4096 UTF-8 bytes each.

The immutable fingerprint is the lowercase SHA-256 of UTF-8:

```
lokal.upload.v1\n<decimal audio bytes>\n<lowercase audio SHA-256>\n<fields>
```

`<fields>` concatenates, in order, title, artist, album, extension and
originalFilename. Missing optional fields are empty strings. Each field is
encoded as its decimal **UTF-8 byte length**, a colon, then its unmodified text;
there is no separator after it. No Unicode normalization is applied. Extensions
are normalized to lowercase before fingerprinting. Changing any immutable field
for the same operation returns 409 `operation_conflict`.

Headerless legacy uploads remain supported, including unknown-length requests.
They use the same verified-content deduplication and retain their old response
shape. They do not acquire replay guarantees for an operation key they never sent.

## Outcomes and cancellation

`GET /api/remote/files/operations/:operationId` returns a bounded JSON outcome:

- 404: `{protocolVersion:1, operationID, state:"absent"}`; this alone does not
  fence a delayed request and does not justify submitting with a fresh key.
- 200: `{protocolVersion:1, operationID, state, bytes, sha256, fingerprint}`.
  State is `receiving`, `retryable`, `cancelled` or `committed`.
- A committed outcome additionally includes `trackId`, `file_hash` and the
  boolean `available`. Availability is checked against actual current bytes,
  rather than trusting the historical hash column.

`POST /api/remote/files/operations/:operationId/cancel` takes JSON
`{bytes, metadata}` with the same immutable fingerprint. It atomically records
cancellation even if the body has not arrived, and fences a receiving generation
before interrupting its socket. Replaying that key returns 410 and cannot create
a track. If the original already committed, cancellation returns the committed
outcome and keeps the original. Cancellation never deletes public desktop music.

A successful explicit upload returns the committed outcome plus `ok:true`.
Replaying a committed key returns its stable track ID and never writes new audio.
If its original was deleted or changed, replay returns 410 with `available:false`;
a deliberate new copy needs a new operation. Concurrent different keys for
identical verified bytes converge inside the SQLite writer on the same original.

## Durability and file ownership

The receipt schema is versioned independently of the main library. Future or
unversioned existing receipt storage refuses writes. No network/file await holds
a SQLite writer. A receiving lease carries a process owner and generation;
recovery fences even an older worker that is still alive before COMMIT.

Audio is privately staged under the selected phone folder’s `.lokal-phone-upload-incoming` directory, verified using open
file descriptors, inode witnesses and SHA-256, and fsynced before track/receipt
COMMIT. Friendly publication uses a no-overwrite hard link and a persisted target
name. A crash can leave a playable private original; status/replay repairs its
friendly publication. Private cleanup requires exact ownership and no library
references. Substituted files and uncertain ownership are preserved. User files
with colliding names are preserved and a free suffix is selected.

Files and SQLite FULL sync are mandatory. Directory fsync is mandatory on Unix;
Node on Windows cannot flush directory handles, so this implementation does not
claim Windows power-loss qualification. These tests establish host process-crash
recovery, not physical disk failure or Apple background delivery. Up to 100,000
receipts are retained; capacity refusal preserves old outcomes rather than
forgetting cancellation tombstones. A process admits at most four receiving jobs.

## Verification

Run `npm run test:phone-copy` on Node 24. Tests use real HTTP, actual paired-token
authentication, file-backed SQLite/WAL, real audio metadata parsing, real file
substitution and child processes terminated at seven commit/publication edges.
They also cover lost replies, same-content concurrency, a still-live fenced
worker, active account changes, revocation, cancellation before a delayed body,
future schemas, reduced durability and preservation of existing desktop music.
The SQLite test adapter uses Node's built-in binding; Electron production uses
better-sqlite3. Electron packaging and installed Windows/macOS behavior still
need platform qualification. This desktop protocol does not itself enable the
currently disabled native iPhone transfer capabilities.

For the cross-repository production Swift wire check, compile the mobile transfer
contract executable and run:

```sh
LOKAL_NATIVE_PEER_BINARY=/absolute/path/to/transfer-contracts node --test scripts/phone-upload-native-peer.test.cjs
```

That test is explicit and separate from `test:phone-copy`: ordinary desktop
receiver tests do not silently substitute a Swift mock or require a Swift SDK.

The selected incoming-phone destination and volume guard from desktop 14.0.2
are retained. Folder changes and unavailable/replaced selected volumes fence
in-flight work; there is no app-storage fallback. Artwork stays in the private
app artwork directory. Private receiving audio is excluded from normal scans,
watcher events and direct single-file indexing, so an independent library scan
cannot publish a track before the upload transaction.
