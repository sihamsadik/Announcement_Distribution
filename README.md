# Telegram Announcement Distribution System

A robust, enterprise-grade Telegram bot service built with **Node.js**, **TypeScript**, **Telegraf**, **Prisma 7**, and **PostgreSQL** to distribute course announcements from designated source forum topics to student project groups with native forwarding, media album grouping, idempotency, and automated failure recovery.

---

## Table of Contents

- [1. Architecture Overview](#1-architecture-overview)
- [2. Message Distribution Flow](#2-message-distribution-flow)
- [3. Database Schema & Entity Relationships](#3-database-schema--entity-relationships)
- [4. Delivery Status Lifecycle](#4-delivery-status-lifecycle)
- [5. Idempotency & Concurrency Safety](#5-idempotency--concurrency-safety)
- [6. Retry Strategy & Failure Recovery](#6-retry-strategy--failure-recovery)
- [7. Supported Message Types & Telegram Capabilities](#7-supported-message-types--telegram-capabilities)
- [8. Telegram Group Permissions & Privacy Mode](#8-telegram-group-permissions--privacy-mode)
- [9. Environment Configuration](#9-environment-configuration)
- [10. Bot Commands Reference](#10-bot-commands-reference)
- [11. Installation, Build & Startup](#11-installation-build--startup)
- [12. Verification & Testing](#12-verification--testing)
- [13. Known Limitations & Reliability Trade-offs](#13-known-limitations--reliability-trade-offs)
- [14. Security Considerations](#14-security-considerations)

---

## 1. Architecture Overview

The system is architected as a modular, decoupled event-driven pipeline where Telegram updates are ingested, validated, persisted, and forwarded without data loss or duplicate deliveries.

```mermaid
flowchart TD
    subgraph Telegram ["Telegram Cloud"]
        User["Course Coordinator / Admin"]
        StudentGroups["Destination Groups (A1, A2, ...)"]
        TG_API["Telegram Bot API"]
    end

    subgraph BotApp ["Announcement Distribution System (Node.js / TypeScript)"]
        Listener["Telegraf Bot Listener\n(src/bot/bot.ts)"]
        Auth["Admin Authorization\n(src/bot/auth.ts)"]
        Detector["Source Topic Detector\n(src/bot/detector.ts)"]
        DistService["Distribution Service\n(src/services/distribution.service.ts)"]
        AlbumService["Media Album Debounce Engine\n(src/services/album.service.ts)"]
        ForwardService["Native Forwarding Engine\n(src/services/forwarding.service.ts)"]
        DelivService["Delivery Tracking & Idempotency\n(src/services/delivery.service.ts)"]
        RetryService["Background Retry Worker\n(src/services/retry.service.ts)"]
    end

    subgraph Database ["PostgreSQL Persistence (Prisma 7)"]
        SourceTable[("SourceGroup")]
        DestTable[("DestinationGroup")]
        LogTable[("ForwardingLog")]
    end

    User -->|"Post Announcement"| TG_API
    TG_API -->|"Update Event"| Listener
    Listener --> Auth
    Listener --> Detector
    Detector -->|"Check Registered Source"| SourceTable
    Detector -->|"Announcement Detected"| DistService

    DistService -->|"Media Album Updates"| AlbumService
    AlbumService -->|"Batch Flushed (forwardMessages)"| DistService

    DistService -->|"1. Query Active Destinations"| DestTable
    DistService -->|"2. Claim In-Flight (PENDING)"| DelivService
    DelivService --> LogTable

    DistService -->|"3. Native Forward"| ForwardService
    ForwardService -->|"forwardMessage / forwardMessages"| TG_API
    TG_API --> StudentGroups

    ForwardService -->|"Result"| DistService
    DistService -->|"4. Mark SUCCESS / RETRYING / FAILED"| DelivService

    RetryService -->|"Poll Due Retries (Optimistic Lock)"| LogTable
    RetryService -->|"Re-attempt Forward"| ForwardService
```

### Component Roles

1. **Telegram Listener & Handlers** (`src/bot/bot.ts`, `src/bot/messages.ts`):
   - Manages Telegraf lifecycle, incoming updates, polling, error catching, and graceful termination (`SIGINT`/`SIGTERM`).
2. **Authorization Layer** (`src/bot/auth.ts`):
   - Verifies whether a command sender is in `ADMIN_USER_IDS` or is an Administrator/Creator in the Telegram chat.
3. **Source Detector** (`src/bot/detector.ts`):
   - Filters out non-group messages, commands, bot messages, and extracts `message_thread_id` to match against registered sources.
4. **Source & Destination Services** (`src/services/source.service.ts`, `src/services/destination.service.ts`):
   - Handles multi-source isolation and destination lifecycle (registration, query, soft-deactivation).
5. **Distribution Service** (`src/services/distribution.service.ts`):
   - Orchestrates distribution across active destinations with inter-destination delay and partial failure isolation.
6. **Album Service** (`src/services/album.service.ts`):
   - Implements a sliding debounce collection window (500ms default, 2500ms ceiling) to collect multi-photo/video albums and forward them atomically via `forwardMessages`.
7. **Forwarding Service** (`src/services/forwarding.service.ts`):
   - Native forwarding engine classifying Telegram exceptions into transient vs permanent error categories.
8. **Delivery Service** (`src/services/delivery.service.ts`):
   - Enforces database-level idempotency, atomic concurrency gates, and stale claim recovery.
9. **Retry Service** (`src/services/retry.service.ts`):
   - Background worker with optimistic locking and exponential backoff to re-attempt transient failures.

---

## 2. Message Distribution Flow

The sequence below illustrates what occurs when an announcement is posted in a registered forum topic:

```mermaid
sequenceDiagram
    autonumber
    actor Admin as Professor / Admin
    participant TG as Telegram Bot API
    participant Bot as Distribution Service
    participant DB as PostgreSQL (Prisma)
    participant Dest as Student Groups

    Admin->>TG: Posts announcement in Source Topic
    TG->>Bot: bot.on('message') update
    Bot->>Bot: isEligibleMessage (exclude bots & commands)
    Bot->>DB: detectSourceAnnouncement: findSource(chatId, topicId)
    DB-->>Bot: SourceGroup record (Match found)
    Bot->>DB: getActiveDestinations(sourceGroupId)
    DB-->>Bot: [Dest1, Dest2, Dest3]

    loop For Each Active Destination
        Bot->>DB: claimDelivery(srcChatId, msgId, destId)
        alt Already SUCCESS
            DB-->>Bot: canDeliver = false (ALREADY_DELIVERED)
            Bot->>Bot: Skip destination
        else Already in-flight (<60s)
            DB-->>Bot: canDeliver = false (ALREADY_PENDING)
            Bot->>Bot: Skip concurrent attempt
        else Unclaimed or Stale
            DB-->>Bot: canDeliver = true (PENDING recorded)
            Bot->>TG: forwardMessage(destChatId, srcChatId, msgId)
            alt Forward Successful
                TG-->>Bot: 200 OK (new message_id)
                Bot->>DB: markSuccess(srcChatId, msgId, destId)
                TG-->>Dest: Delivered with original attribution
            else Transient Error (Timeout / 429 RateLimit)
                TG-->>Bot: Error (ETIMEDOUT / retry_after)
                Bot->>DB: markFailure (status: RETRYING, nextRetryAt: now + backoff)
            else Permanent Error (Bot Kicked / Write Forbidden)
                TG-->>Bot: Error (CHAT_WRITE_FORBIDDEN)
                Bot->>DB: markFailure (status: FAILED, terminal)
            end
        end
    end
```

---

## 3. Database Schema & Entity Relationships

The PostgreSQL database enforces relational integrity and composite uniqueness constraints via Prisma 7:

```mermaid
erDiagram
    SourceGroup ||--o{ DestinationGroup : "has many"
    DestinationGroup ||--o{ ForwardingLog : "tracks"

    SourceGroup {
        string id PK "UUID"
        bigint chatId "Telegram Group Chat ID"
        bigint topicId "Forum Topic Thread ID"
        string name "Human Readable Name"
        boolean isActive "Active Toggle"
        datetime createdAt
    }

    DestinationGroup {
        string id PK "UUID"
        string sourceGroupId FK "References SourceGroup.id"
        bigint chatId "Telegram Destination Chat ID"
        string groupName "Display Group Name"
        boolean isActive "Active Toggle"
        datetime createdAt
    }

    ForwardingLog {
        string id PK "UUID"
        bigint sourceChatId "Source Group Chat ID"
        int sourceMessageId "Source Message ID"
        string destinationGroupId FK "References DestinationGroup.id"
        ForwardingStatus status "PENDING | RETRYING | SUCCESS | FAILED"
        string errorMessage "Truncated Error Description"
        int retryCount "Attempt Counter (0..maxRetries)"
        datetime lastAttemptAt "Timestamp of Last Attempt"
        datetime nextRetryAt "Timestamp Scheduled for Next Retry"
        datetime createdAt
        datetime updatedAt
    }
```

### Relational Constraints and Indexes
- **`SourceGroup`**:
  - `@@unique([chatId, topicId])`: Guarantees a topic in a group can only be registered once.
  - `@@index([chatId])`: Fast lookup of forum topics per chat.
- **`DestinationGroup`**:
  - `@@unique([sourceGroupId, chatId])`: Prevents duplicate registration of the same destination under one source.
  - `@@index([sourceGroupId, isActive])`: Optimizes querying active destinations during message distribution.
- **`ForwardingLog`**:
  - `@@unique([sourceChatId, sourceMessageId, destinationGroupId])`: **Core idempotency constraint**. Guarantees that at most one delivery record exists for a message-destination pair.
  - `@@index([status, nextRetryAt])`: Efficient index scan for background retry polling (`status = 'RETRYING' AND nextRetryAt <= NOW()`).
  - `@@index([sourceChatId, sourceMessageId])`: Quick status audits for specific announcements.

---

## 4. Delivery Status Lifecycle

Deliveries transition through an explicit state machine:

```mermaid
stateDiagram-v2
    [*] --> PENDING: claimDelivery() atomically inserts record
    PENDING --> SUCCESS: Telegram Bot API returns 200 OK
    PENDING --> RETRYING: Transient failure (Network / Rate Limit / 5xx)
    PENDING --> FAILED: Permanent failure (Kicked / Write Forbidden / Invalid Chat)
    PENDING --> PENDING: Stale claim (>60s crash recovery)

    RETRYING --> PENDING: Due retry claimed via optimistic lock
    RETRYING --> FAILED: Maximum retry count reached (retryCount >= maxRetries)

    SUCCESS --> [*]: Terminal (never forwarded again)
    FAILED --> [*]: Terminal
```

- **`PENDING`**: Delivery is currently being processed. Prevents concurrent workers or re-delivered updates from executing a duplicate send.
- **`SUCCESS`**: Delivery was acknowledged by Telegram. This state is terminal and will never be re-forwarded.
- **`RETRYING`**: Transient failure occurred. Delivery is scheduled for automated background retry with exponential backoff.
- **`FAILED`**: Terminal failure. Either the error was non-retryable (e.g. bot lack permissions) or maximum retry attempts were exhausted.

---

## 5. Idempotency & Concurrency Safety

### 1. Database-Enforced Unique Constraint
The PostgreSQL composite constraint `@@unique([sourceChatId, sourceMessageId, destinationGroupId])` serves as the primary idempotency barrier. Even if multiple processes attempt to insert delivery records concurrently, PostgreSQL permits only one to commit while rejecting duplicates with Prisma error `P2002`.

### 2. Pre-Execution Idempotency Check
Before contacting Telegram, `claimDelivery()` checks the database:
- If `SUCCESS` exists: The destination is immediately skipped (`Already delivered (Idempotency)`).
- If `PENDING` exists (<60 seconds): The message is currently in flight by another worker and is skipped (`Delivery currently in flight`).

### 3. Crash Recovery for In-Flight Deliveries
If the application crashes while a delivery is in `PENDING` state:
- The record becomes stale after 60 seconds (`updatedAt` threshold).
- On the next attempt or application restart, `claimDelivery()` detects the stale record, logs a warning, and safely reclaims it for delivery.
- Additionally, `retryService.recoverStalePendingDeliveries()` runs automatically at startup, finding all orphaned `PENDING` records and converting them to `RETRYING` with immediate eligibility.

### 4. Distributed Uncertainty Boundary (At-Least-Once Delivery)
External API calls cannot participate in a two-phase database transaction with Telegram's servers. In the rare event that:
1. The bot invokes `telegram.forwardMessage(...)` and Telegram accepts the message.
2. The bot process crashes (e.g. OOM killer or power loss) **before** writing `SUCCESS` to PostgreSQL.
3. Upon restart, the database only reflects `PENDING` (>60s stale) and re-attempts delivery.
This creates a small window where an announcement may be delivered more than once upon ungraceful crash recovery. This is a fundamental trade-off of distributed network systems without two-phase commit.

---

## 6. Retry Strategy & Failure Recovery

### 1. Error Classification Matrix

| Error Type | Category | Transient? | Action |
| :--- | :--- | :--- | :--- |
| `RATE_LIMITED` | HTTP 429 ("Too Many Requests") | Yes | Scheduled retry respecting `retry_after` |
| `NETWORK_ERROR` | `ETIMEDOUT`, `ECONNRESET`, fetch failed | Yes | Exponential backoff retry |
| `SERVER_ERROR` | Telegram 500, 502, 503, 504 | Yes | Exponential backoff retry |
| `BOT_NOT_MEMBER` | Bot kicked or not in destination group | No | Immediate terminal `FAILED` |
| `PERMISSION_DENIED` | `CHAT_WRITE_FORBIDDEN`, no send rights | No | Immediate terminal `FAILED` |
| `PROTECTED_CONTENT` | Source chat forbids forwarding | No | Immediate terminal `FAILED` |
| `MESSAGE_NOT_FOUND` | Message deleted in source | No | Immediate terminal `FAILED` |
| `INVALID_CHAT_ID` | Bad destination chat ID | No | Immediate terminal `FAILED` |

### 2. Exponential Backoff Formula
$$\text{delaySeconds} = \min\left(\max\left(\text{initialDelay} \times 2^{\text{retryCount}},\, \text{retryAfterSeconds}\right),\, \text{maxDelay}\right)$$
- If Telegram returns `retry_after`, the backoff delay directly respects Telegram's requested wait time.
- Standard defaults: Initial delay = 5s, Max delay = 300s, Max retries = 3.

### 3. Concurrency Safety & Optimistic Locking
Background retry polling claims records using atomic conditional updates:
```sql
UPDATE "ForwardingLog"
SET "status" = 'PENDING', "updatedAt" = NOW()
WHERE "id" = :id AND "updatedAt" = :expectedUpdatedAt AND "status" = 'RETRYING';
```
If two workers attempt to claim the same retry concurrently, only one update returns row count 1; the other returns 0 and safely skips.

---

## 7. Supported Message Types & Telegram Capabilities

All messages are forwarded natively via Telegram Bot API (`forwardMessage` / `forwardMessages`). This preserves original author attribution, avoids downloading media to disk, and eliminates network upload overhead:

| Message Type | Telegram Format | Attribution Preserved | Native Grouping |
| :--- | :--- | :---: | :---: |
| **Text** | Plain text, markdown, HTML, code blocks | Yes | N/A |
| **Photos** | JPEG / PNG with or without captions | Yes | Yes (single) |
| **Media Albums** | 2–10 Photos & Videos sharing `media_group_id` | Yes | Yes (grouped via `forwardMessages`) |
| **PDF Documents** | PDF files with file name and caption | Yes | Yes |
| **General Documents**| DOCX, XLSX, ZIP, TAR, TXT archives | Yes | Yes |
| **Videos** | MP4, MOV with captions and duration | Yes | Yes |
| **Voice Messages** | OGG Opus voice notes with audio waveform | Yes | Yes |
| **Video Notes** | Round circular video clips | Yes | Yes |
| **Stickers** | Static, animated (.TGS), video stickers (.WEBM)| Yes | Yes |
| **Animations / GIFs**| Animated GIFs with captions | Yes | Yes |
| **Polls & Quizzes** | Native Telegram poll widgets | Yes | Yes |

---

## 8. Telegram Group Permissions & Privacy Mode

### 1. Group Privacy Mode
Telegram bots operate with **Group Privacy Mode** enabled by default. In privacy mode, bots only receive:
- Commands starting with `/`.
- Direct `@mentions`.
- Replies to the bot's own messages.
- Messages in groups where the bot is an **Administrator**.

**Requirement**: To detect announcements in the source group without mentioning the bot:
1. Add the bot to the source group.
2. Promote the bot to **Administrator** (or disable Group Privacy via `@BotFather` -> `/setprivacy` -> `Disable`).

### 2. Destination Group Permissions
In each student destination group:
- Ensure the bot is a member and has permissions to:
  - **Send Messages**
  - **Send Photos & Videos**
  - **Send Documents**
- Administrator status in destination groups is optional unless general group permissions restrict regular members from posting.

---

## 9. Environment Configuration

Create a `.env` file in the root directory (based on `.env.example`):

```env
# Telegram Bot Token from @BotFather (Required)
TELEGRAM_BOT_TOKEN="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"

# PostgreSQL Database Connection URL (Required)
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/announcement_db?schema=public&host=/tmp"

# Comma-separated Administrator Telegram User IDs (Optional)
ADMIN_USER_IDS="123456789,987654321"

# Retry Configuration (Optional defaults shown)
MAX_RETRY_COUNT=3
INITIAL_RETRY_DELAY_SECONDS=5
MAX_RETRY_DELAY_SECONDS=300
RETRY_POLL_INTERVAL_MS=10000

# Health Check & Monitoring Server (Optional defaults shown)
HEALTH_PORT=3000

# Structured Logging Configuration (Optional)
LOG_LEVEL="info"         # "debug", "info", "warn", or "error"
LOG_FORMAT="text"        # "text" for development, "json" for production

# Application Environment
NODE_ENV="development"
```

---

## 10. System Health Checks & HTTP Endpoints

The service runs a lightweight, non-blocking HTTP health check server using Node.js's standard `http` library on `HEALTH_PORT` (default: `3000`):

### 1. Liveness Probe (`GET /health` or `GET /health/live`)
- **Purpose**: Verifies that the Node.js process is active and has completed initialization.
- **Status Code**: `200 OK` (or `503 Service Unavailable` if shutting down).
- **Example Response**:
  ```json
  {
    "status": "ok",
    "uptimeSeconds": 142,
    "isInitialized": true,
    "isShuttingDown": false,
    "timestamp": "2026-11-18T05:30:00.000Z"
  }
  ```

### 2. Readiness Probe (`GET /health/ready`)
- **Purpose**: Verifies that both PostgreSQL and Telegram Bot API connectivity are active.
- **Status Code**: `200 OK` if all dependencies are healthy; `503 Service Unavailable` if either fails.
- **Example Response (Healthy)**:
  ```json
  {
    "status": "ready",
    "uptimeSeconds": 142,
    "timestamp": "2026-11-18T05:30:00.000Z",
    "checks": {
      "app": { "status": "healthy", "uptimeSeconds": 142, "isInitialized": true, "isShuttingDown": false },
      "database": { "status": "healthy", "latencyMs": 3, "details": { "reachable": true } },
      "telegram": { "status": "healthy", "latencyMs": 95, "details": { "botId": 123456789, "username": "MyAnnouncementBot" } }
    }
  }
  ```

---

## 11. Structured Logging & Error Monitoring

The system implements a centralized structured logger (`src/utils/logger.ts`) supporting standard log levels (`debug`, `info`, `warn`, `error`) and dual output formats:

- **Development Mode (`LOG_FORMAT=text`)**: Human-readable, bracketed console logs:
  ```text
  [2026-11-18T05:30:00.000Z] [INFO] [announcement.detected] Recognized announcement in registered source "Final Project" {"sourceChatId":"-100123","sourceMessageId":42}
  ```
- **Production Mode (`LOG_FORMAT=json`)**: Single-line JSON events for ingest into monitoring collectors (Datadog, CloudWatch, Loki):
  ```json
  {"timestamp":"2026-11-18T05:30:00.000Z","level":"INFO","message":"Forwarding completed successfully","event":"forwarding.succeeded","sourceChatId":"-100123","sourceMessageId":42,"destinationChatId":"-100456"}
  ```
- **Security & Redaction**: Automatically scrubs Telegram bot tokens (`[REDACTED_BOT_TOKEN]`) and database URLs with credentials (`[REDACTED_DATABASE_URL]`) from all messages and error stacks.


---

## 10. Bot Commands Reference

| Command | Usage | Description | Access |
| :--- | :--- | :--- | :--- |
| `/start` | `/start` | Bot welcome message | Public |
| `/help` | `/help` | Complete command reference manual | Public |
| `/register_source` | `/register_source [topicId] <name>` | Registers forum topic as an announcement source | Admins Only |
| `/list_sources` | `/list_sources` | Lists all registered announcement sources with status & destination counts | Admins Only |
| `/source_details` | `/source_details <source_id>` | Detailed source inspection: destinations, status, and delivery metrics | Admins Only |
| `/remove_source` | `/remove_source <source_id> [--force]` | Soft-deactivates source (`isActive: false`, guarded deletion with `--force`) | Admins Only |
| `/activate_source` | `/activate_source <source_id>` | Reactivates a deactivated source topic (`isActive: true`) | Admins Only |
| `/register_destination` | `/register_destination <source_id> <name>` | Registers student group under a source topic | Admins Only |
| `/list_destinations` | `/list_destinations [source_id]` | Lists registered destinations (optionally filtered by source) | Admins Only |
| `/remove_destination` | `/remove_destination <dest_id> [--force]` | Soft-deactivates destination (`isActive: false`, guarded deletion with `--force`) | Admins Only |
| `/activate_destination`| `/activate_destination <dest_id>` | Reactivates destination (`isActive: true`) | Admins Only |
| `/delivery_stats` | `/delivery_stats [source_id_or_timeframe] [timeframe]` | In-chat delivery metrics, success/failure rates, retry totals, and timeframe filters | Admins Only |
| `/recent_deliveries` | `/recent_deliveries [limit]` | Lists recent delivery attempts across destinations (default 10, max 50) | Admins Only |
| `/failed_deliveries` | `/failed_deliveries [limit]` | Lists failed or retrying delivery attempts with sanitized errors | Admins Only |
| `/delivery_details` | `/delivery_details <log_id>` | Full inspection of a specific delivery log, timestamps, and error traces | Admins Only |
| `/test_forward` | `/test_forward <dest_chat_id> [msg_id]` | Tests forwarding a single message directly to a destination | Admins Only |

---

## 11. Installation, Build & Startup

### 1. Prerequisites
- **Node.js**: v18.x or v20.x LTS
- **npm**: v9+ or v10+
- **PostgreSQL**: v14, v15, or v16

### 2. Installation
```bash
npm install
```

### 3. Database Migration
```bash
# Validate schema
npx prisma validate

# Run migrations
npx prisma migrate dev --name init_database

# Generate client
npx prisma generate
```

### 4. Build TypeScript
```bash
npm run build
```

### 5. Running the Application
```bash
# Development mode (with live watch via tsx)
npm run dev

# Production mode
npm start
```

---

## 12. Verification & Testing

### 1. Automated Test Suite (Jest)
The test suite consists of 13 comprehensive suites and 207 unit & integration tests covering all system aspects:

```bash
npm test
```

### Test Suites Breakdown

| Test Suite | Purpose | Tests |
| :--- | :--- | :---: |
| `tests/day4_security_validation.test.ts` | Security hardening, input validation, update eligibility, and authorization review | 25 |
| `tests/day3_stats_logging_health.test.ts`| Distribution statistics, structured logging, sanitization, and HTTP health checks | 20 |
| `tests/day3_admin_monitoring.test.ts` | Admin auth security, source/dest lifecycle, deactivation, and in-chat monitoring | 25 |
| `tests/integration_day2.test.ts` | Complete end-to-end integration and reliability verification | 18 |
| `tests/distribution.test.ts` | Multi-destination distribution and isolation | 13 |
| `tests/delivery_tracking.test.ts` | Database idempotency, PENDING claims, and crash recovery | 11 |
| `tests/retry.test.ts` | Exponential backoff, optimistic locking, and background retries | 19 |
| `tests/media_album.test.ts` | Debouncing, album collection ceiling, and media types | 27 |
| `tests/forwarding.test.ts` | Native forwarding, error classification, and token sanitization | 22 |
| `tests/destination.test.ts` | Destination group management, soft-deactivation, and commands | 14 |
| `tests/source.test.ts` | Source registration and forum topic detection | 20 |
| `tests/bot.test.ts` | Telegraf bot setup and error handling | 7 |
| `tests/db.test.ts` | Prisma 7 PostgreSQL integration and cascades | 2 |
| `tests/config.test.ts` | Environment configuration and token validation | 5 |
| **Total** | | **232 passing** |

### 2. Manual Live Telegram Testing Procedure
To verify live in Telegram:
1. Start the bot: `npm run dev`.
2. In the course supergroup, enter a forum topic (e.g. "Final Project").
3. Send: `/register_source Final Project`.
4. Copy the returned `source_id`.
5. In each student group, run: `/register_destination <source_id> Team Alpha`.
6. Post a message in the source topic (text, photo, PDF, voice, or media album).
7. Confirm that the message appears immediately in destination groups with native forwarding attribution.
8. Check database records:
   ```bash
   psql -d announcement_db -c "SELECT * FROM \"ForwardingLog\" ORDER BY \"createdAt\" DESC LIMIT 5;"
   ```

---

## 13. Known Limitations & Reliability Trade-offs

1. **In-Memory Album Debounce Buffer**:
   - Because Telegram does not provide an "album complete" event, album updates are accumulated in memory for 500ms before dispatching. If the bot crashes during this 500ms window, unforwarded album updates in memory are discarded until re-sent.
2. **Sequential Loop for Destination Delivery**:
   - Deliveries to destinations are executed sequentially with a 50ms polite pacing delay. For dozens of destination groups, this runs in under 1–2 seconds. For massive broadcasts across hundreds of groups, a distributed task queue (e.g. BullMQ / Redis) would provide concurrent sharding.
3. **Distributed Two-Phase Commit Limitation**:
   - External network calls cannot participate in a two-phase transaction with PostgreSQL. A crash occurring after Telegram accepts a message but before PostgreSQL commits `SUCCESS` can result in an at-least-once re-send upon crash recovery.

---

## 14. Security Hardening, Input Validation & Authorization Review

### 1. Secret & Environment Variable Protection
- **No Hardcoded Credentials**: Telegram bot tokens, database connection strings, and administrative IDs are read exclusively from environment variables or `.env`.
- **Git Safety**: `.gitignore` strictly excludes `.env` and `.env.*` while keeping `.env.example`.
- **Automated Startup Validation**: `validateStartupConfig` ensures valid bot token format (`<bot_id>:<secret>`), valid PostgreSQL connection string, and valid port bounds (1–65535) before booting services.
- **Secret Redaction**: `logger.sanitize` and `sanitizeError` proactively strip bot tokens and connection passwords from all stdout logs, stack traces, and database error messages.
- **Process Crash Protection**: Global `unhandledRejection` and `uncaughtException` handlers sanitize error output and shut down cleanly on fatal errors.

### 2. Input Validation & Service Boundaries
- **Centralized Validation Layer (`src/utils/validators.ts`)**:
  - `isValidUuid`: Enforces RFC 4122 UUID v4 formatting on all internal and command-line identifiers.
  - `isValidTelegramChatId`: Ensures 64-bit signed Telegram chat IDs are valid non-zero integers.
  - `isValidTelegramTopicId`: Ensures forum thread IDs are strictly positive integers.
  - `validateResourceName`: Sanitizes names, enforces a 100-character upper bound, rejects empty strings, and rejects unsupported ASCII control characters (`[\x00-\x1F\x7F]`) and line breaks.
  - `validateLimit`: Validates and clamps query pagination limits within strict bounds (min 1, max 50).
  - `isValidTimeframe`: Validates time window queries against an allowlist (`24h`, `7d`, `30d`, `all`).
- **Telegram Update Filtering (`isEligibleMessage`)**:
  - Drops updates sent by bots (`from.is_bot === true`) or from the bot itself to prevent infinite forwarding loops.
  - Filters out bot command invocations (`/command ...`).
  - Filters out Telegram service notifications (pinned messages, member joins/leaves, title/photo updates, forum topic creation/editing/closure/reopening).
  - Rejects protected content messages (`has_protected_content === true`) that Telegram forbids from being forwarded.

### 3. Authorization Review & Fail-Closed Access Control
- **Fail-Closed Architecture**: Missing context, unauthenticated users (`userId <= 0` or missing `from`), or Telegram API network failures fail closed and deny access.
- **Context-Aware Chat Segregation**:
  - **Private Chats**: Ordinary members and group admins cannot run administrative commands in direct messages with the bot. Private chats are strictly restricted to IDs explicitly declared in `ADMIN_USER_IDS`.
  - **Group Chats**: Commands require the user to be either in `ADMIN_USER_IDS` or a verified `creator` or `administrator` in that Telegram group (queried via `getChatAdministrators`). Ordinary members are strictly denied.
- **Security Audit Logging**: Every unauthorized action attempt triggers a structured audit log (`event: "security.unauthorized_access"`) recording the user ID, chat ID, chat type, and attempted action.
