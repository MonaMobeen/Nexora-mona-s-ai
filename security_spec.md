# Security Specification & Payload-First TDD

## 1. Data Invariants
1. **Identity Isolation**: Every user document and subcollection (`memories`, `sessions`, `messages`, `documents`, `auditLogs`) is strictly owned by `userId == request.auth.uid` with verified email (`request.auth.token.email_verified == true`).
2. **No PII Leakage**: User profiles exclude `email`, `phone`, or credentials. No collection allows unauthenticated or cross-user reads (`get` or `list`).
3. **Explicit Memory Consent**: Long-term memories in `/users/{userId}/memories/{memoryId}` require `approvedByUser == true` on create and update.
4. **Master Gate Integrity**: Messages under `/users/{userId}/sessions/{sessionId}/messages/{messageId}` validate parent session existence and matching `sessionId` and `userId`.
5. **Temporal & Key Strictness**: All documents enforce `createdAt == request.time`, immutable `userId` and `createdAt`, `hasAll`/`hasOnly` key allowlists on create, and `affectedKeys().hasOnly(...)` on update.
6. **Immutable Audit Trail**: Entries in `auditLogs` cannot be modified or deleted once created.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Cross-Tenant Profile Hijack**: Authenticated user A attempts to read or write `/users/userB`.
2. **Unverified Email Bypass**: Request with `email_verified: false` tries to create a memory entry.
3. **Shadow Field Injection (Ghost Admin)**: `UserProfile` create includes extra field `isAdmin: true` or `role: "admin"`.
4. **Unconsented Memory Persistence**: `UserMemory` create sets `approvedByUser: false` or omits `approvedByUser`.
5. **Timestamp Forgery**: `ConversationSession` create supplies a past or future client timestamp instead of `request.time`.
6. **Immutable Owner Tampering**: Update on `UserMemory` attempts to mutate `userId` or `createdAt`.
7. **ID Poisoning**: Document ID contains invalid characters (`../admin`) or exceeds 128 characters.
8. **Payload Exhaustion (Denial of Wallet)**: `SessionMessage.content` exceeds 12,000 characters or `UserMemory.fact` exceeds 1,000 characters.
9. **Orphaned Message Injection**: Creating a message under a non-existent `sessionId` or mismatched `sessionId` field.
10. **Audit Log Tampering**: User attempts to update or delete an entry in `/users/{userId}/auditLogs/{logId}`.
11. **Terminal Status Mutation**: Updating a `KnowledgeDocument` status from `indexed` back to an invalid enum `"hacked"`.
12. **Blanket List Scraping**: User A attempts a collection-group or cross-user `list` query on `/users` or `/users/userB/memories`.
