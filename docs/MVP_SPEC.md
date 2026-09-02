# CheburChat MVP Specification

## 1. Document Purpose

This document is the implementation specification for the first working MVP of CheburChat.
It is intended to be detailed enough that the MVP can be implemented directly from this file without re-deciding product or protocol behavior.

The spec captures:
- product goals
- threat model
- architecture
- crypto and key-management decisions
- VK Web integration behavior
- storage and data models
- protocol/message formats
- UI states and copy
- limits and error handling
- testing and acceptance criteria
- explicitly deferred post-MVP work

This is the source of truth for the MVP unless later amended.

## 2. Product Summary

CheburChat is a browser extension that adds end-to-end encrypted one-to-one text messaging on top of VK Web.

Users continue using the standard VK website, but when both sides use CheburChat, have exchanged keys, and the contact key is explicitly trusted, the extension encrypts messages before sending and decrypts them after receiving.

If the recipient does not use CheburChat, the sender can still communicate in plaintext through VK as usual.

## 3. Product Name

The product name is `CheburChat`.
Use `CheburChat` in English product/docs contexts and `Чебурчат` in Russian user-facing UI copy.

Naming:
- user-facing branding is `CheburChat` / `Чебурчат`
- protocol wrapper prefix is `CHEBURCHAT:v1:`
- canonical install URL is `https://cheburchat.com/install`
- package and debug identifiers use the `cheburchat` name

The legacy `CheburCrypt` / `CHEBURCRYPT` / `cheburcrypt.app` naming was fully migrated to
`CheburChat` / `CHEBURCHAT` / `cheburchat.com` on 2026-06-09, before launch. No backward-compatibility
shims are kept (there were no released clients or sent messages to stay compatible with).

## 4. MVP Scope

### In Scope
- Chrome-compatible browser extension
- VK Web only
- one-to-one direct text messages only
- long-term user identity keypair
- public-key-based encryption only
- key announcement inside VK chat
- automatic encryption for contacts with a trusted key
- encrypted message rendering in VK Web UI
- trust-state UI with lock indicators
- private/public key import and export in armored text form
- basic fingerprint display in text form
- storage in browser extension local storage

### Out of Scope for MVP
- VK mobile app support
- Max integration
- group chats
- attachments or files
- voice messages
- stickers, GIFs, reactions
- message editing/deletion sync logic
- seed phrase backup
- four-word verification phrases
- emoji verification
- multi-device sync
- forward secrecy / ratcheting protocol
- interoperability with generic OpenPGP clients
- Firefox packaging
- browser sync storage

## 5. Goals

### Primary Goal
Protect message plaintext from passive VK server-side storage and inspection when both participants use CheburChat.

### Secondary Goals
- make encrypted chat feel native inside VK Web
- keep encryption automatic only after a contact key is explicitly trusted
- keep non-encrypted states obvious through UI differences
- support simple onboarding and key exchange from within chat
- allow future platform expansion, including Max, without changing the identity model

## 6. Non-Goals

CheburChat MVP does **not** aim to:
- hide metadata from VK
- resist a compromised browser or malicious extension environment
- replace mature secure messengers like Signal
- provide deniability or forward secrecy
- support all OpenPGP capabilities
- provide seamless key recovery beyond armored import/export

## 7. Threat Model

### Protected Against
- plaintext visibility during passive VK server-side storage and inspection of encrypted messages
- passive server-side storage/inspection of encrypted message content
- accidental plaintext sending when a valid trusted contact key is already established, except where explicitly allowed by the product rules

### Not Protected Against
- browser malware
- malicious or compromised extensions
- compromised endpoint device
- session/account takeover at VK level
- active or compromised VK client-side code that reads the native compose input or decrypted DOM
- metadata collection such as who talks to whom, when, how often, and from what device/IP
- screenshots, clipboard leakage, or shoulder surfing
- transport-controlled replay, duplication, or reordering of otherwise valid signed messages

### Security Positioning
CheburChat provides message content confidentiality against passive server/network observers for supported chats on VK Web, but not against active code running at the VK endpoint and not full endpoint security.

### Evidence and Likelihood of Active VK Client Risk
- No current network evidence is known, and the audit did not demonstrate, that the VK client transmits every typed character or draft plaintext to its servers.
- The risk is inferred from capability, not observed behavior: the native VK compose field and decrypted page DOM are technically readable by active client-side code.
- Exploitation would require VK or an attacker controlling its frontend to deliberately add plaintext-collection JavaScript, either broadly or selectively for a chosen account or group. It is not an ordinary CheburChat malfunction.
- For an ordinary user, the beta product assessment treats this as a low-likelihood scenario primarily relevant to a targeted high-value-adversary model; the impact would nevertheless be high if it occurred.
- Eliminating the capability requires moving both composition and decrypted rendering into an extension-owned Side Panel, cross-origin iframe, or separate window. That materially reduces the native VK chat experience and is deferred beyond the current beta.

## 8. Crypto Decision

### Crypto Engine
The MVP uses `OpenPGP.js` as the crypto implementation library.

### Why
- mature browser-compatible crypto library
- avoids inventing low-level cryptography from scratch
- already supports key generation, encryption, decryption, signing, parsing, and armored key import/export

### Constraint
CheburChat uses a **restricted OpenPGP profile**. The product must not expose or depend on generic OpenPGP behavior that is irrelevant to the MVP.

## 9. Restricted OpenPGP Profile

### Allowed
- ECC-based keys suitable for modern OpenPGP usage
- one long-term identity keypair per user
- one remote chat recipient per encrypted message, plus sender self-encryption
- armored public/private key import and export
- signed key announcements
- encrypted message payloads encoded into a CheburChat wrapper

### Forbidden in MVP
- password-based message encryption
- arbitrary multi-recipient messages beyond the remote contact and sender self-copy
- group encryption
- detached signatures as user-visible transport artifacts or standalone `.sig` files
- cleartext signed messages as user-visible transport artifacts
- keyserver integration
- Web of Trust UX or trust import
- compression
- automatic key rotation
- multiple active devices per identity
- raw armored PGP blocks as the normal in-chat transport format

### Algorithm Direction
App-generated keys must use the OpenPGP.js `curve25519` configuration.
This is the required CheburChat MVP key profile.

### Import Compatibility
Imported identities are not required to use the app-generated `curve25519` profile.
Any imported OpenPGP key that parses successfully and is usable for the MVP flows may be accepted.

### Interop Rule
Implementations must not choose between multiple ECC curves at runtime for app-managed identities.
Two compliant CheburChat implementations must generate identities using the same OpenPGP.js `curve25519` profile.

## 10. Identity Model

### Core Rule
Each user has exactly one long-term CheburChat identity keypair for the MVP.

### Identity Characteristics
- generated once on first setup, unless imported
- stored locally in the extension
- reused across chats and sessions in that browser profile
- platform-neutral by design

### Important Clarification
The identity is **not** VK-specific.
CheburChat must be designed so the same identity can later be bound to multiple platforms, including VK and Max.

## 11. Account Binding Model

A user identity may be associated with one or more platform account bindings.

### MVP Binding Requirement
For MVP, only VK bindings are implemented.

### Data Concept
A binding consists of:
- `platform`
- `accountId`
- `displayName` when available
- binding timestamps

### Account Identifier Type
`accountId` must always be stored and serialized as a string, never as a JSON number.
At the VK integration and background-worker boundary, an account ID must additionally match `^[1-9][0-9]*$`.
The generic identity model remains string-based so future platform adapters may define their own identifier syntax.

### Example
- identity keypair: one per user
- binding 1: `platform = vk`, `accountId = "123456"`
- future binding 2: `platform = max`, `accountId = "xyz"`

The protocol and storage model must avoid naming assumptions that hardcode VK into the identity itself.

## 12. Contact Model

A contact record represents a remote person on a specific platform account.

### Contact Key
A contact is identified by:
- `platform`
- `accountId`

### Account Identifier Type
`accountId` must always be stored and serialized as a string.

### Contact Record Fields
Each contact record stores at minimum:
- `platform`
- `accountId`
- `displayName` if known
- `publicKeyArmored`
- `fingerprintShort`
- `fingerprintFull`
- `trustState`
- `firstSeenAt`
- `lastUpdatedAt`
- `lastAnnouncementMessageId` if available
- `hasKeyConflict`
- `previousFingerprintFull` if a conflict was detected

## 13. Trust States

The product trust state is app-defined and separate from raw OpenPGP terminology.
Only contact-level trust states belong in this section.

### `missing`
No public key is known for this contact.
- UI: standard VK send state, no encryption lock
- sending: plaintext allowed

### `new`
A public key is known, but the user has not explicitly marked it trusted.
- UI: gray lock
- sending: plaintext only
- behavior: the user must verify the fingerprint and explicitly mark the contact as trusted before encrypted sending is enabled

### `trusted`
A public key is known and explicitly trusted.
- UI: green lock
- sending: encrypted automatically

### `changed`
A newly announced public key differs from the stored key.
- UI: problem state, not green
- sending: must not silently continue as trusted
- behavior: require user review and acceptance of the new key before removing the `changed` state
- post-accept state: return the contact directly to `trusted`

### `rejected`
A public key is known, but the user explicitly rejected it.
- UI: blocked/problem state, not green
- sending: plaintext only
- behavior: the user may later restore the key to `new` for fingerprint review and explicit trust

## 13.1 Message-Level Render States

These are not contact trust states and must not be stored as the contact's persistent trustState value.

### `decrypt_failed`
A specific encrypted message could not be decrypted.
- scope: message-level only
- UI: per-message error state
- storage: may be derived at render time or stored as transient message UI state only
- note: this does **not** by itself change the contact trust state

## 14. Lock and Send UI Rules

### Trusted Contact
- show green lock
- send button visually differs from VK default
- preferred label: `Send Encrypted`
- encrypted sending is automatic

### New but Unverified Contact
- show gray lock
- send area must not present the chat as encrypted yet
- plaintext sending remains available through the normal VK send path
- provide a clear verification action before trust is granted
- avoid scary warning language

### Missing Key
- no encrypted lock state
- send button uses normal plaintext VK state

### Changed Key
- show problem state, not green
- UI must communicate that the contact key changed
- do not present the chat as securely trusted until the user accepts the new key and explicitly marks it trusted again

### Decrypt Failure
- show error indicator on the failed message only
- do not automatically mark the contact as changed

## 15. Automatic Encryption Behavior

### Default Rule
If a contact is in `trusted`, CheburChat encrypts outgoing messages automatically.

### Plaintext Rule
If a contact is in `missing`, `new`, or `rejected`, plaintext sending remains available.

### Safety Rule
If a contact previously had a trusted key and a different key is later announced, CheburChat must not silently keep treating that contact as trusted.

## 16. First-Run Onboarding

On first use, the extension shows two choices:
- `Create Identity`
- `Import Existing Identity`

### Create Identity Flow
- generate a new long-term identity keypair
- persist it locally
- derive and display fingerprint
- offer export immediately after creation

### Import Identity Flow
- accept armored private key text
- validate that the key parses and is usable
- import and persist it locally
- derive and display fingerprint

## 17. Key Replacement Warning

Any action that creates a new identity while another identity already exists, or imports a different identity over an existing one, must show a strong warning.

### Required Warning Content
- `If you replace your identity key, contacts who trusted your previous key will no longer be able to verify you automatically.`
- `You may also lose access to previously encrypted message history that was encrypted for your old key.`
- `Only replace your key if you understand that older encrypted conversations may become unreadable.`

### Required Warning Surfaces
- settings page before generating a new key over an existing identity
- settings page before importing a different key over an existing identity
- any future destructive key-reset action

## 18. Key Export and Import

### MVP Support
- armored private key export
- armored private key import
- armored public key export/copy

### Not in MVP
- seed phrase backup
- mnemonic derivation
- emoji verification
- four-word verification

### UX Notes
- export should be easy to copy
- import should validate and show a clear error if parsing fails
- the app must not pretend imported keys are compatible if the format is unsupported

## 19. Fingerprints

### MVP Fingerprint Strategy
Use plain text fingerprints only.

### Display Requirements
- show a short fingerprint for common UI
- show a full fingerprint in expanded details
- support copy action for both fingerprint and public key

### Suggested Format
- short fingerprint: grouped uppercase text representation
- full fingerprint: full stable textual representation

### Deferred
Do not implement four-word phrases or emoji fingerprints in MVP.

## 20. VK Transport Model

CheburChat messages are sent through the normal VK chat transport as ordinary message text, but formatted in a machine-detectable wrapper.

### Message Types
- key announcement message
- encrypted content message

### Versioning Rule
All CheburChat transport messages must include protocol version `v1`.

## 21. Wrapper Format

The extension must use a deterministic prefix so messages can be recognized reliably.

### Required Prefixes
- `CHEBURCHAT:v1:key:`
- `CHEBURCHAT:v1:msg:`

### Parsing Rule
Only messages that match the exact prefix for a supported version should be parsed as CheburChat messages.

### Unsupported Versions
If a message uses an unknown future version, it should render as unsupported rather than failing silently.

## 22. Key Announcement Design

A key announcement serves two functions:
- allow CheburChat clients to exchange keys
- act as a readable invitation for users who do not have the extension installed

### Scenario A: Recipient Has CheburChat
- extension detects the announcement
- extension parses the machine-readable payload
- extension stores or updates the sender key
- extension hides/replaces the raw transport text with clean CheburChat UI
- contact enters `new`, remains `trusted`, enters `changed`, or remains `rejected` depending on prior state and prior user actions

### Scenario B: Recipient Does Not Have CheburChat
The key announcement should remain readable as an ordinary VK message and act as onboarding copy.

### Required Human-Readable Invitation Behavior
A key announcement must visibly say that:
- the sender shared their CheburChat key
- encrypted chat is available with CheburChat
- a link is available to install or learn more

### Suggested Human-Readable Copy
`Я поделился с вами своим ключом шифрования CheburChat. Установите CheburChat, чтобы включить защищённый чат: https://cheburchat.com/install`

### Landing Page Recommendation
The install link for MVP is fixed to `https://cheburchat.com/install`.
This is the canonical install URL for key announcements in MVP.
It should point to a product-owned landing page rather than directly to a single browser-store listing.

### Required Serialized Wire Format
App-generated key announcements must use one exact text serialization so all implementations produce the same transport shape.

### Canonical Key Announcement Text
The full VK message text for a key announcement must be:

```text
Я поделился с вами своим ключом шифрования CheburChat. Установите CheburChat, чтобы включить защищённый чат: https://cheburchat.com/install
CHEBURCHAT:v1:key:<base64url-utf8-json-payload>
```

### Serialization Rules
- the first line is always the human-readable invitation text
- the second line is always the machine-readable payload
- the separator between them is exactly one newline character (`\n`)
- there must be no extra text before the first line
- there must be no extra text after the machine-readable payload
- the machine-readable payload must start at the beginning of the second line
- the payload encoding is base64url of a UTF-8 JSON object

### Parsing Rule
CheburChat clients must treat the first line as display-only text and the `CHEBURCHAT:v1:key:` line as the authoritative protocol payload.
On receive, parsers may accept either the canonical two-line app-generated text or the standalone machine-readable payload line after normalization.
On receive, parsers should also accept legacy English invite lines for backward compatibility with previously sent key announcements.
On receive, parsers may trim trailing newlines or other trailing ASCII whitespace after the machine-readable payload before validation, but must reject any extra non-whitespace content.

## 23. Key Announcement Payload Requirements

The machine-readable payload for a key announcement must include enough information to bind the key to the sender account and the protocol version.

### Required Fields
- protocol version
- sender platform
- sender account ID
- sender public key
- sender fingerprint
- sender display label
- signature over the announcement payload

### Canonical JSON Field Names
The decoded UTF-8 JSON payload for a key announcement must use these exact top-level keys:
- `v` for protocol version
- `platform` for sender platform
- `accountId` for sender account ID as a string
- `publicKeyArmored` for the sender public key
- `fingerprint` for the sender fingerprint
- `displayName` for the sender label as a string
- `sig` for the signature

### Field Normalization Rules
- `accountId` must always be a string
- `displayName` must always be present
- if no display name is available, `displayName` must be the empty string `""`

### Canonical Signed Payload
The signature must cover the canonical JSON serialization of the announcement object **excluding** the `sig` field.
Implementations must serialize keys in this exact order before signing and before verification:
- `v`
- `platform`
- `accountId`
- `publicKeyArmored`
- `fingerprint`
- `displayName`

### Signature Mechanism
Key announcements must use an internal detached OpenPGP signature over the canonical UTF-8 bytes of the announcement object without the `sig` field.

### Signature Encoding
The `sig` field must contain the base64url encoding of the binary detached OpenPGP signature packet.

### Clarification
This internal detached-signature mechanism is allowed even though user-visible detached-signature artifacts and cleartext-signed transport are forbidden elsewhere in the MVP.

### Required Validation Rules
Before storing or updating a contact key from a key announcement, the extension must verify all of the following:
- the wrapper prefix and version are supported
- the JSON payload parses successfully
- the announcement signature is valid for the included public key
- `sender platform` matches the current platform context, which is `vk` in MVP
- `sender account ID` matches the actual VK author of the message carrying the announcement
- `sender account ID` also matches the currently open direct-dialog partner before mutating that contact record

### Forwarded or Pasted Announcement Rule
If a key announcement appears inside a chat but the embedded sender identity does not match the actual VK message author and active dialog partner, the extension must not store it as that contact's key. It may show the message as untrusted raw text or as an invalid announcement, but it must not mutate contact trust state from it.

### Key Change Detection Rule
A contact moves to `changed` only when a newly received explicit announcement contains a different public key from the one already stored.

### Important Rule
`decrypt_failed` must never automatically imply `changed`.

## 24. Encrypted Message Design

Encrypted message transport must be compact enough for VK message length constraints while still using OpenPGP.js internally.

### Message Preparation
Before encryption, the logical message payload should include at minimum:
- protocol version
- sender platform
- sender account ID
- timestamp
- plaintext message body

### Canonical Logical Message JSON
Before passing plaintext into OpenPGP.js, the extension must serialize the logical message payload as UTF-8 JSON with these exact top-level keys:
- `v`
- `platform`
- `accountId`
- `ts`
- `body`

Implementations must serialize these keys in that exact order before encryption.

### Message Field Normalization Rules
- `accountId` must always be a string
- `ts` must be an RFC 3339 / ISO 8601 UTC timestamp string with millisecond precision, for example `2025-03-19T12:34:56.789Z`
- `body` must contain the UTF-8 plaintext message body

### Encryption Rule
- encrypt to exactly two OpenPGP recipients in MVP:
  - the remote contact's current public key
  - the sender's own current public key
- use OpenPGP.js binary output where possible
- wrap the final binary payload as a text-safe encoded value
- place it behind the `CHEBURCHAT:v1:msg:` prefix

### Encrypt-to-Self Rule
Encrypt-to-self is mandatory in MVP.

### Reason
The sender must be able to decrypt and re-render their own previously sent encrypted messages from VK chat history after page reload, navigation, or browser restart.

### Scope Clarification
This does not change the product from one-to-one messaging into group or arbitrary multi-recipient messaging.
It remains a one-to-one chat model with one remote recipient, while also including the sender as a required self-recipient for local history readability.

### Encrypted Message Signature Mechanism
Encrypted chat messages must use OpenPGP sign-and-encrypt in one operation.
The sender signs the canonical logical message JSON with their current private key and encrypts that signed message to:
- the remote contact public key
- the sender's own current public key

### Encrypted Message Payload Encoding
The transport payload after `CHEBURCHAT:v1:msg:` must be the base64url encoding of the binary signed-and-encrypted OpenPGP message bytes.

### Recommended Final Shape
`CHEBURCHAT:v1:msg:<base64url-payload>`

### UX Rule
Raw binary or raw armored PGP blocks must not be shown as the normal chat experience for CheburChat users.

## 25. Signing Policy

### Required in MVP
Key announcements must be signed.

### Required in MVP
Encrypted messages must also be signed.

### Reason
Encryption alone protects confidentiality but does not always prove authorship to the recipient.
Signed announcements are mandatory because they anchor identity exchange, and signed encrypted messages are mandatory so injected ciphertext is not rendered as if it came from the trusted chat partner.

### Practical Constraint
Because VK messages have a hard size limit, encrypted message signing must be accounted for in the length budget from the start. If a signed encrypted payload exceeds the limit, the message must be rejected as too long rather than silently downgraded to an unsigned encrypted message.

## 26. VK Message Length Limit

### Hard Limit
VK message length limit for this project is treated as `4096` characters.

### Consequence
The final encrypted transport text, including wrapper prefix and encoding overhead, must fit within this limit.

### Product Rule
CheburChat must measure the final serialized outgoing message length before sending.

### Failure Behavior
If the encrypted transport text exceeds VK limits:
- do not send the message
- do not silently truncate
- show a clear user-visible error

### Suggested Error Copy
`Encrypted message is too long for VK.`

## 27. Plaintext Budget Rule

Because the encrypted transport adds overhead, the maximum plaintext length that can be safely encrypted is lower than `4096` characters.

### MVP Requirement
The compose/send flow must be based on **serialized encrypted length**, not plaintext character count alone.

### Conservative UI Estimate
Until measured against the implemented OpenPGP.js sign-and-encrypt pipeline, the compose UI should treat approximately `1800` UTF-8 bytes of plaintext as the conservative warning threshold for encrypted messages.
That is roughly `1800` ASCII/Latin characters or about `900` Cyrillic characters.

### Soft Warning Guidance
At or above the warning threshold, the UI should warn that encrypted message size may exceed VK limits, while the final allow/block decision must still use actual serialized length.

## 27.1 VK Text Processing Compatibility

VK may apply text-rendering transformations such as auto-linking the install URL on the first line of a key announcement.

### Required Parser Behavior
- parse CheburChat messages from normalized plain text extracted from the VK message node, not from inner HTML
- normalize line endings to `\n` before parsing
- for key announcements, recognize the `CHEBURCHAT:v1:key:` payload line after normalization even if the human-readable invitation line is absent or changed
- tolerate VK-added hyperlink markup on line 1 only if the normalized plain text remains unchanged

### Mutation Rule
If VK modifies the machine-readable payload line in any way, the announcement or encrypted message must be treated as invalid rather than heuristically repaired

## 28. Content Script Responsibilities

The content script is responsible for VK page integration.

### Required Duties
- detect relevant VK chat/dialog pages
- observe DOM changes in message list and compose UI
- identify active chat partner account ID
- detect CheburChat wrapper messages
- replace rendered transport text with decrypted/plain UI for supported users
- decorate the send area with lock and encryption state
- trigger key announcement and verification UI flows

## 29. Background or Service Worker Responsibilities

The background context is responsible for secure application logic.

### Required Duties
- generate/import/export keys
- store identity and contact records
- perform encryption and decryption operations
- sign and verify key announcements
- verify encrypted message signatures
- manage trust-state transitions
- provide APIs to content scripts

## 30. Storage Model

All MVP persistent data is stored locally in the extension using `chrome.storage.local`.

### Storage Layout Rule
Persistent objects must be stored under separate namespaced keys rather than as one monolithic JSON blob.

### Required Keying Strategy
At minimum, use separate storage entries for:
- `identity`
- `settings`
- `binding:<platform>:<accountId>`
- `contact:<platform>:<accountId>`

### Concurrency Rule
Content scripts must not write directly to `chrome.storage.local`.
All persistent writes must go through the background/service worker so the extension has a single logical writer.
The worker must restrict `chrome.storage.local` access to trusted extension contexts; content scripts read and mutate state only through validated worker messages.

### Race-Mitigation Rule
The background/service worker must serialize each per-record read-modify-write transaction and avoid whole-database rewrites so concurrent updates from multiple tabs cannot overwrite fields in the same record or unrelated contact records.

### Transient Key-Share Intent
Opening a VK dialog for key sharing must use a short-lived, one-time intent in `chrome.storage.session`.
The intent must not be encoded as a public URL command and may be consumed only by a validated VK content-script context for the matching account.

### Identity Record
At minimum:
- `publicKeyArmored`
- `privateKeyArmored` or encrypted equivalent
- `fingerprintShort`
- `fingerprintFull`
- `createdAt`
- `updatedAt`
- `schemaVersion`

### Binding Records
At minimum:
- `platform`
- `accountId`
- `displayName`
- `createdAt`
- `updatedAt`

### Contact Records
At minimum:
- `platform`
- `accountId`
- `displayName`
- `publicKeyArmored`
- `fingerprintShort`
- `fingerprintFull`
- `trustState`
- `firstSeenAt`
- `lastUpdatedAt`
- `lastAnnouncementMessageId`
- `hasKeyConflict`
- `previousFingerprintFull`

### Settings
At minimum:
- schema version
- debug mode flag
- optional UI preferences
- future feature flags

## 31. Private Key Storage Requirement

The MVP stores the private key locally.

### Preferred
Store it encrypted at rest behind a local passphrase if feasible without jeopardizing MVP delivery.

### Minimum Acceptable MVP
If passphrase protection is deferred, the security model and settings UI must clearly reflect that browser-local storage is the trust boundary.
Private-key export in settings must be loaded only after an explicit user action and offered as a download rather than kept in a permanently rendered text field.
Sensitive key input fields must disable spellcheck, autocorrection, and form autocomplete where supported.

## 32. Chat Open Flow

When a user opens a supported VK chat:
- identify the current chat partner
- load the contact record if it exists
- determine trust state
- update the send UI accordingly
- offer key-sharing entry points where appropriate

### If No Key Exists
CheburChat may offer a `Share My Key` action.

## 33. Outgoing Message Flow

### Plaintext Path
If contact state is `missing`, `new`, or `rejected`:
- send plaintext through VK unchanged
- do not decorate sent message as encrypted

### Encrypted Path
If contact state is `trusted`:
- collect plaintext from compose area
- serialize logical payload
- encrypt using OpenPGP.js to both the remote contact key and the sender's own current key
- encode into CheburChat wrapper
- validate final message length
- replace outgoing message text with wrapper payload
- send through VK

### Changed-Key Path
If contact state is `changed`:
- do not present the chat as trusted
- require the user to review and accept the new key before leaving the `changed` state
- after acceptance, return the contact directly to `trusted`
- block encrypted sending for that contact until the user explicitly accepts the new key
- allow plaintext sending only through the normal non-encrypted VK send path, with no encrypted lock state

## 34. Incoming Message Flow

### Non-CheburChat Message
- leave the VK message unchanged

### Key Announcement
- parse wrapper
- verify payload and signature
- verify that the embedded sender platform and sender account ID match the actual VK message author
- verify that the embedded sender account ID matches the active direct-dialog partner before updating that partner's stored key
- compare public key against stored record
- if none exists, store as `new`
- if same key exists, keep existing trust state
- if different key exists, set state to `changed`

### Encrypted Message
- parse wrapper
- decode payload
- decrypt
- verify the encrypted-message signature
- verify that the decrypted sender platform and sender account ID match the actual VK message author
- if the VK message author is the active dialog partner, verify that the decrypted sender account ID also matches the active dialog partner
- if the VK message author is the local user, verify that the decrypted sender account ID matches the local user's own bound VK account ID
- only after those checks pass, replace raw transport display with plaintext UI
- if decryption fails, render decrypt-failure UI
- if signature validation or sender-identity validation fails, do not render the message as a valid CheburChat message from that contact

## 35. Decrypt Failure UI

When decryption fails for a specific message, show clear explanatory copy.

### Required Copy Meaning
It must communicate that the message could not be decrypted and that possible causes include:
- wrong key
- changed key
- damaged payload

### Suggested Copy
`Cannot decrypt this message. Possible reasons: wrong key, changed key, or damaged payload.`

## 36. Changed-Key UX

When a new key announcement conflicts with a stored key:
- mark the contact as `changed`
- remove or suppress green trusted appearance
- require explicit user review before the new key becomes trusted

### UX Tone
Do not use unnecessarily alarming language, but do make the state clearly different from trusted.

### Suggested Copy
`This contact's encryption key has changed. Review it before trusting encrypted messages again.`

## 37. Verification UX for MVP

Verification is intentionally simple in MVP.

### Included
- plain text fingerprint display
- manual out-of-band comparison if users want it
- ability to mark a contact as trusted after review
- accepting a changed key immediately restores the contact to trusted

### Excluded
- four-word verification phrases
- emoji verification
- advanced ceremony flows

## 38. Non-User Recipient Experience

When a recipient does not use CheburChat, key-announcement messages must still be understandable.

### Requirement
The onboarding invitation and install/learn-more link must remain visible in plain VK chat.

### Goal
CheburChat users should be able to invite contacts into encrypted chat through the same message that carries the key announcement.

## 39. Unsupported Version Handling

If a CheburChat message carries a wrapper version not supported by the installed extension:
- do not attempt unsafe parsing
- show an unsupported-version placeholder if the extension intercepts it
- otherwise leave the raw text visible

## 40. Error Classification

Internal error types should distinguish at minimum:
- wrapper parse failure
- payload decode failure
- OpenPGP parse failure
- decryption failure
- announcement signature verification failure
- encrypted-message signature verification failure
- storage mismatch
- contact key conflict
- unsupported protocol version
- message too long

User-facing messaging should remain concise.

## 41. Logging and Debugging

### MVP Requirement
Support internal debug logging that can be enabled in development.

### Debug Logging Must Never
- leak private key material
- log decrypted message content by default in production builds

## 42. UX Copy Requirements Summary

### Key Replacement Warning
Must include loss of access to older encrypted history encrypted with the old key.

### Key Announcement Invite
Must explicitly say a key was shared and that CheburChat enables encrypted chat, with a link.

### Too-Long Error
Must clearly state that the encrypted message exceeds VK limits.

### Decrypt Failure
Must mention wrong key, changed key, or damaged payload.

## 43. Extension Architecture

### Required Components
- `manifest`
- `content script`
- `background/service worker`
- `options/settings page`
- shared protocol/crypto/storage modules

### Architectural Principle
Keep protocol, storage, VK integration, and UI state logic separated so the same crypto and protocol code can later be reused for Max integration.

### Manifest Requirement
The extension must use Chrome Extension Manifest V3.

### MV3 Lifecycle Requirement
Because MV3 background logic runs in a service worker that may be terminated and restarted, all background APIs for crypto and storage must be idempotent and safe to retry.

### Long-Running Operation Requirement
Key generation, import, and export flows must not depend on long-lived in-memory service-worker state across suspension boundaries.

## 44. Future Max Support Requirements

Even though Max is out of MVP scope, the code and spec should remain compatible with adding it later.

### Therefore
- do not hardcode VK into identity terminology
- define bindings/contact keys by `(platform, accountId)`
- keep transport wrapper brand-neutral except for product name and protocol prefix
- isolate VK DOM integration from the rest of the system

## 45. Acceptance Criteria

The MVP is considered complete only if all of the following are true.

### Onboarding
- user can create a new identity
- user can import an existing armored private key
- user can export their current key material

### Key Exchange
- a user can share a key announcement in VK chat
- a recipient with CheburChat stores that key
- a recipient without CheburChat sees an understandable invite message and link

### Encryption
- a chat with a trusted contact key encrypts outgoing text automatically
- the encrypted message is sent through VK within size limits
- the recipient extension decrypts, validates sender identity, verifies signature, and renders it correctly
- the sender can reload the page and still decrypt and render their own previously sent encrypted messages

### Trust States
- trusted contacts display green lock
- new/unverified contacts display gray lock
- missing-key contacts do not appear encrypted
- conflicting replacement keys enter changed-key state

### Errors
- too-long encrypted messages are blocked with a clear error
- undecryptable messages show a clear decrypt-failure explanation
- unsupported versions do not break the chat UI

### Persistence
- identity and contact state survive page reloads and browser restarts

## 46. Test Plan Requirements

The implementation phase must include tests or manual verification coverage for:
- identity creation
- identity import/export
- key announcement generation and parsing
- key announcement canonical two-line serialization
- key announcement detached-signature generation and verification using the `sig` field format
- accountId serialized as a string in all signed payloads
- displayName present as a string, including empty-string normalization
- canonical timestamp serialization format
- app-generated keys use the OpenPGP.js `curve25519` profile
- same-key re-announcement behavior
- changed-key detection behavior
- rejection of pasted or forwarded announcements whose embedded sender does not match the VK author/dialog
- plaintext send when no key exists
- encrypted send only when a trusted key exists
- sender can decrypt and re-render their own sent encrypted messages after reload
- mandatory encrypted-message signing
- decrypt success path
- rejection of decrypted payloads whose embedded sender metadata does not match the VK author
- rejection of partner-authored decrypted payloads whose embedded sender metadata does not match the active dialog partner
- rejection of locally authored decrypted payloads whose embedded sender metadata does not match the user's own bound VK account ID
- decrypt failure path
- VK auto-linking on the first line of a key announcement does not break parsing
- unsupported version handling
- over-limit message blocking
- multi-tab contact updates do not overwrite unrelated records
- correct UI state mapping for missing/new/trusted/changed/rejected

## 47. Explicitly Deferred Post-MVP Backlog

These items are intentionally excluded from MVP and must not be silently half-implemented.

- seed phrase recovery
- four-word verification phrases
- emoji verification
- group chats
- attachments/files
- multi-device identity support
- automatic key rotation
- contact key history (active + retired keys) for verifying previously received encrypted messages after a contact key change
- optional retention of previous own private keys as decrypt-only material for historical message access after local key replacement
- browser sync of keys
- Max integration
- stronger passphrase gate for private key if deferred in MVP
- richer verification ceremony UX
- optional UX warning when OpenPGP signature creation time appears skewed relative to local clock, without hard-failing already tolerated future-skew cases

## 48. Implementation Notes to Preserve

During implementation, preserve these product decisions:
- product name is `CheburChat`
- automatic encryption occurs only for trusted contact keys
- unverified contacts use gray, not scary warning UX
- trusted contacts use green encrypted UI
- key announcements must work for both extension users and non-users
- app-generated key announcements use a fixed two-line serialization with invitation text on line one and `CHEBURCHAT:v1:key:` payload on line two, while parsing treats the machine-readable payload line as authoritative
- key announcements use a canonical `sig` field containing base64url-encoded detached OpenPGP signature bytes
- key announcements and encrypted messages must validate embedded sender identity against the actual VK message author and active dialog
- account identifiers are strings everywhere in storage and protocol payloads
- app-generated identities use the OpenPGP.js `curve25519` profile
- key replacement warnings must mention possible loss of older encrypted history
- the identity model must remain platform-neutral for future Max support
- VK's `4096` message limit is a hard constraint and must be enforced on serialized encrypted payloads

## 49. Final MVP Freeze

The CheburChat MVP is defined by the following fixed decisions:
- OpenPGP.js is the crypto engine
- app-generated keys use the OpenPGP.js `curve25519` profile
- VK Web is the only supported transport in MVP
- the product supports one-to-one text only
- there is one long-term identity keypair per user
- key import/export is armored text only
- seed phrases and human-friendly verification phrases are deferred
- key announcements are signed and double as a non-user invitation message
- encrypted messages are signed and sender-authenticated in MVP
- key announcements use the canonical install URL `https://cheburchat.com/install`
- the extension uses Manifest V3 and background-mediated storage writes
- encryption is automatic only for contacts with a trusted key
- trust states map to lock colors and visible UI differences
- the protocol uses versioned `CHEBURCHAT:v1` wrappers
- implementation must remain extensible to future Max support

## 50. Technical Appendix

This section pins implementation details so independent clients remain wire-compatible.
Merged from the original `MVP_TECHNICAL_APPENDIX.md`.

### Runtime
- Chrome Extension Manifest V3.
- JavaScript modules.
- OpenPGP.js (`openpgp` npm package).

### Canonical Types
- `platform`: string, must be `"vk"` in MVP.
- `accountId`: string only; the VK adapter/worker boundary accepts only positive decimal IDs matching `^[1-9][0-9]*$`.
- `displayName`: string only, always present (`""` when unknown).
- `ts`: RFC 3339 UTC with milliseconds, e.g. `2025-03-19T12:34:56.789Z`.

### Install URL
- Canonical key-announcement URL: `https://cheburchat.com/install`.

### Key Announcement Wire Format
```text
Я поделился с вами своим ключом шифрования CheburChat. Установите CheburChat, чтобы включить защищённый чат: https://cheburchat.com/install
CHEBURCHAT:v1:key:<base64url-utf8-json-payload>
```
- Exactly two lines.
- Exactly one newline separator.
- No extra prefix/suffix text.
- Parser tolerance: implementations may trim trailing final newlines and other trailing ASCII whitespace after the machine-readable payload before validation.
- Any trailing non-whitespace content after the payload must be rejected.

### Key Announcement JSON
Signed object key order:
1. `v`
2. `platform`
3. `accountId`
4. `publicKeyArmored`
5. `fingerprint`
6. `displayName`

Envelope object adds:
7. `sig`

`sig` format:
- Detached OpenPGP signature packet bytes.
- Encoded with base64url.

### Encrypted Message JSON
Canonical key order before encryption:
1. `v`
2. `platform`
3. `accountId`
4. `ts`
5. `body`

Encrypted transport:
- OpenPGP sign+encrypt binary packet.
- Base64url-encoded.
- Wrapped as `CHEBURCHAT:v1:msg:<payload>`.
- Parser tolerance: implementations may trim trailing final newlines and other trailing ASCII whitespace after the payload before validation.
- Any trailing non-whitespace content after the payload must be rejected.

### OpenPGP Profile
- Generate identities with `curve25519`.
- Sign key announcements.
- Sign encrypted messages.
- Encrypt each message to:
  - remote contact key
  - sender key (encrypt-to-self)

### Storage Keys
Use separate namespaced keys in `chrome.storage.local`:
- `identity`
- `settings`
- `binding:<platform>:<accountId>`
- `contact:<platform>:<accountId>`

All writes must go through background worker.
Per-record read-modify-write mutations must be serialized, and `chrome.storage.local` must be restricted to trusted extension contexts.
Short-lived one-time key-share intents use `chrome.storage.session`, never URL query commands.

MVP contact storage keeps a single active public key per contact record.
Per-contact key history/keyring support (active + retired keys) is deferred post-MVP.

### Validation Gates
Announcement accept requires:
- prefix/version valid
- payload parse success
- signature valid
- embedded `platform` matches context
- embedded `accountId` matches message author
- embedded `accountId` matches active dialog

Decrypted message render requires:
- decrypt success
- signature verification success
- decrypted `platform`/`accountId` match the actual VK message author
- if the VK author is the active dialog partner, decrypted `accountId` must also match the active dialog partner
- if the VK author is the local user, decrypted `accountId` must match the local user's own bound VK account ID

### Limits
- VK hard limit: 4096 chars on final wrapped text.
- Conservative warning threshold: 1800 UTF-8 bytes of plaintext.
- Approximate guidance: ~1800 ASCII/Latin characters or ~900 Cyrillic characters.
- Block (do not truncate) when encrypted wrapper exceeds limit.
- Reject incoming protocol wrappers above the VK hard limit before crypto processing.
- Process newly discovered VK message nodes in bounded batches so one DOM mutation cannot monopolize the content script.
