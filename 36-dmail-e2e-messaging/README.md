# Wallet-to-Wallet End-to-End Encrypted Messaging

## Problem

We want a private messaging system addressed by wallet, not by email or phone. Two users with wallet keypairs should be able to exchange messages that the server *cannot read* — true end-to-end encryption — while the server still does the unglamorous work of storing messages, maintaining inbox/sent/archive/trash folders, tracking read state, and surfacing a contacts list.

There is a tension at the heart of this design. The platform also runs a personal agent that helps the user recall their own past activity ("when did I last hear from Alice about the audit?"). For that to work, *something* about each message must be indexed into the user's agent memory. But indexing the plaintext body would defeat the entire point of E2E encryption. The system must store and index only what is safe — never the message contents.

This guide describes a model where the server is a *blind relay and folder manager*: it persists opaque ciphertext envelopes it cannot decrypt, manages mailbox state, and indexes only sender-chosen metadata (subject + addressing) into the agent's memory — never the encrypted body.

## Design decisions

**The server stores ciphertext envelopes, never plaintext.**
Encryption happens entirely on the client. Each message is stored as an envelope of three opaque fields plus routing metadata:
- `bodyCiphertext` — the encrypted message body (opaque to the server)
- `bodyIv` — the per-message initialization vector / nonce
- `ephemeralPublicKey` — the sender's ephemeral public key for this message

The server treats all three as opaque blobs. It never holds a private key and can never derive the shared secret needed to decrypt.

**Ephemeral-key (sealed-box style) encryption gives forward secrecy per message.**
For each message the sender generates a fresh ephemeral keypair, derives a shared secret with the recipient's *published* public key (an X25519/NaCl-box-style ECDH), encrypts the body with that secret + a random IV, and discards the ephemeral private key. The recipient combines their long-term private key with the stored `ephemeralPublicKey` to derive the same secret and decrypt. Because each message uses a fresh ephemeral key, compromising one message's key does not unlock the others.

**A public-key directory keyed by wallet enables addressing.**
Users publish their long-term public key once (`POST /keypair`, upsert by wallet). To send to someone, the client fetches `GET /keypair/:wallet`, encrypts to that key, and sends. A contact's `hasKeypair` flag tells the UI whether a recipient can receive encrypted mail at all. Private keys never leave the client.

**Folders are server-side state on a single message row, not copies.**
Inbox / sent / archive / trash are derived from columns on one message row — `archivedAt`, `deletedAt`, `readAt` — combined with whether the caller is the sender or recipient. This avoids duplicating envelopes per folder and keeps state transitions to single-column updates.

**Soft delete, then hard delete.**
A first delete sets `deletedAt` (moves to trash, still recoverable). A second delete on an already-trashed message removes the row permanently. This is the familiar two-stage trash without a separate table.

**Read receipts are recipient-driven and idempotent.**
Reading a message (`GET /message/:id`) stamps `readAt` only if the caller is the recipient and it is not already set. Stats compute unread as inbox messages with a null `readAt`.

**Every query is scoped to the caller's wallet — the message id is not a capability.**
Reading, deleting, archiving, and marking read all re-check that the authenticated wallet is the sender and/or recipient of the loaded row. Knowing a message UUID grants nothing on its own.

**Only metadata is indexed into agent memory — never the body.**
On send, the system records a short memory note ("message sent to Alice: «subject»") with structured metadata (direction, message id, recipient, subject, timestamp) so the agent can recall *that a conversation happened* and help the user navigate it. The encrypted body is never passed to the memory indexer. Indexing is fire-and-forget and non-fatal: a memory failure must never block message delivery. The subject line is the deliberate trade-off — it is treated as metadata the sender chose to make searchable, not as protected content; users who want full secrecy can leave subjects generic.

## Algorithm

```
Publish key (once):
  POST /keypair { publicKeyB64 }   → upsert directory[wallet] = publicKeyB64

Send (client-side encryption):
  recipientPub = GET /keypair/:recipient
  eph = generateEphemeralKeyPair()
  shared = ecdh(eph.private, recipientPub)
  iv = random()
  bodyCiphertext = encrypt(shared, iv, plaintext)
  POST /send { recipientWallet, subject, bodyCiphertext, bodyIv,
               ephemeralPublicKey: eph.public }
    server: store envelope (opaque); resolve sender/recipient handles
    server: remember({ content: "sent to <recipient>: <subject>",
                       metadata: { direction, messageId, recipient, subject } })   // metadata ONLY, fire-and-forget
    server: discard nothing it could decrypt — it never had a key

Read (client-side decryption):
  msg = GET /message/:id   (must be sender or recipient)
    if caller == recipient and !readAt: set readAt = now
  shared = ecdh(myPrivate, msg.ephemeralPublicKey)
  plaintext = decrypt(shared, msg.bodyIv, msg.bodyCiphertext)

Folders (single-row state):
  inbox   = recipient == me AND archivedAt IS NULL AND deletedAt IS NULL
  sent    = sender    == me AND deletedAt IS NULL
  archive = recipient == me AND archivedAt IS NOT NULL AND deletedAt IS NULL
  trash   = (sender|recipient == me) AND deletedAt IS NOT NULL

Delete: if deletedAt set → hard delete row; else set deletedAt (soft)
```

## Reference implementation

See [`e2e-messaging.ts`](./e2e-messaging.ts) in this directory. The server model (`MessageRelay`) stores opaque envelopes, manages folders/read/archive/delete with wallet-scoped authorization, maintains the public-key directory, and indexes *only metadata* into an injectable memory sink. A small `DemoCrypto` helper (built on Node's `crypto` ECDH + AES-GCM) plays the role of the client so the demo shows a real round-trip the server never sees in plaintext.

## Usage

```typescript
import { MessageRelay, DemoCrypto } from "./e2e-messaging.js";

const memoryNotes: unknown[] = [];
const relay = new MessageRelay((note) => memoryNotes.push(note)); // memory sink (metadata only)

// Each user has a long-term keypair; publish the public half
const alice = DemoCrypto.generateIdentity();
const bob = DemoCrypto.generateIdentity();
relay.publishKey("0xALICE", alice.publicKeyB64);
relay.publishKey("0xBOB", bob.publicKeyB64);

// Alice encrypts to Bob's published key and sends an opaque envelope
const bobPub = relay.getKey("0xBOB")!.publicKeyB64;
const env = DemoCrypto.seal(bobPub, "the audit is clean");
relay.send("0xALICE", { recipientWallet: "0xBOB", subject: "Audit", ...env });

// The server stored ciphertext it cannot read; Bob decrypts locally
const msg = relay.readMessage("0xBOB", relay.inbox("0xBOB")[0].id);
console.log(DemoCrypto.open(bob.privateKeyB64, msg)); // "the audit is clean"
```

## Limitations and extensions

- **Subject + addressing are metadata, not secrets.** They are stored server-side in the clear and indexed into agent memory. Treat them as routing/searchable metadata; keep sensitive detail in the encrypted body.
- **No transcript authentication / deniability here.** The model encrypts for confidentiality; add a signature or MAC over the envelope if you need sender authentication, and consider a ratchet (e.g. Double Ratchet) for stronger forward secrecy across a conversation.
- **Key distribution is trust-on-first-use.** The directory returns whatever public key the wallet published; there is no out-of-band verification. Add key fingerprints / safety numbers for users to compare.
- **The server learns the social graph.** Even without bodies, it sees who messages whom and when. Metadata-resistant designs (mixnets, sealed sender) are a much larger undertaking.
- **Lost private key = lost mail.** True E2E means the server cannot help recover messages. Offer client-side key backup/escrow if your users need recovery.
