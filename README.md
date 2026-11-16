# Telegram Announcement Distribution System

A Telegram bot service built with **Node.js**, **TypeScript**, **Telegraf**, and **PostgreSQL** to distribute final-project announcements from a designated source group to destination student groups.

---

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Bot Creation via BotFather](#bot-creation-via-botfather)
- [Environment Configuration](#environment-configuration)
- [Telegram Bot Group Permissions & Privacy Mode](#telegram-bot-group-permissions--privacy-mode)
- [Installation and Building](#installation-and-building)
- [Database Schema & Prisma 7](#database-schema--prisma-7)
- [Running the Application](#running-the-application)
- [Verification and Testing](#verification-and-testing)
- [Security Considerations](#security-considerations)

---

## Overview

The Telegram Announcement Distribution System integrates with the Telegram Bot API to streamline communication during final projects. In its current initial phase:
- It connects to the Telegram Bot API using Telegraf.
- Handles `/start` and `/help` commands.
- Provides graceful startup and shutdown.
- Validates environment configurations securely.

---

## Prerequisites

- **Node.js** (v18.x or later recommended; v20 LTS tested)
- **npm** (v9+ or v10+)

---

## Bot Creation via BotFather

To create your Telegram bot and obtain an API token:

1. Open Telegram and search for the official **[@BotFather](https://t.me/BotFather)**.
2. Start a chat with BotFather and send the command:
   ```text
   /newbot
   ```
3. Enter a display name for your bot (e.g., `Final Project Announcement Bot`).
4. Enter a unique username ending in `bot` (e.g., `FinalProjectAnnounce_bot`).
5. BotFather will provide an HTTP API token formatted like:
   ```text
   123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
   ```
6. **Keep this token secret.** You will place it in your local `.env` file.

---

## Environment Configuration

1. Copy `.env.example` to `.env` if `.env` does not already exist:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and set your bot token:
   ```env
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
   ```
3. Never commit `.env` to Git. The `.gitignore` file is configured to exclude all `.env` files.

---

## Telegram Bot Group Permissions & Privacy Mode

To prepare for message reception and distribution in subsequent milestones, the following Telegram settings are required:

### 1. Group Privacy Mode
- By default, Telegram bots operate with **Group Privacy Mode** enabled. In this mode, bots only receive:
  - Commands that start with `/` (e.g. `/start`, `/help`).
  - Direct mentions of the bot (e.g. `@YourBotName`).
  - Replies to the bot's own messages.
  - Messages if the bot is an Administrator in the group.
- **For Announcement Distribution**: The bot will need to observe announcements published in the designated source group.
  - **Recommended Approach**: Add the bot as an **Administrator** in the source group. When a bot is an administrator, Telegram automatically disables privacy mode restrictions for that group, allowing it to receive announcement posts.
  - **Alternative Approach**: In `@BotFather`, send `/setprivacy`, choose your bot, and set it to `Disable`. This allows the bot to receive normal group messages even as a regular member.
  - *Note*: Always adjust privacy settings exclusively via BotFather or the Telegram client; do not use unsupported automation.

### 2. Administrator Access in the Source Group
- Add the bot to the primary announcement source group.
- Promote the bot to **Administrator** with at minimum the permission to **Read Messages**.

### 3. Destination Groups Permissions
- Add the bot to each destination student project group.
- Ensure the bot has permission to **Send Messages** (as well as embed links or send media if announcements contain them).
- Administrator status in destination groups is optional unless group settings restrict regular members from sending messages.

---

## Installation and Building

Install project dependencies:
```bash
npm install
```

Compile TypeScript to JavaScript (`dist/`):
```bash
npm run build
```

Run test suite:
```bash
npm test
```

---

## Database Schema & Prisma 7

The application uses **PostgreSQL** and **Prisma 7** for data persistence.

### Models

1. **`SourceGroup`**: Represents an announcement origin (a Telegram group chat and specific topic/thread ID).
   - `id`: UUID Primary Key
   - `chatId`: BigInt (Telegram Chat ID)
   - `topicId`: BigInt (Telegram Topic Thread ID)
   - `name`: Human-readable identifier
   - Unique: `(chatId, topicId)`

2. **`DestinationGroup`**: Represents student groups mapped to receive announcements.
   - `id`: UUID Primary Key
   - `sourceGroupId`: Foreign Key referencing `SourceGroup.id` (`onDelete: Cascade`)
   - `chatId`: BigInt (Telegram Destination Chat ID)
   - `groupName`: Human-readable name
   - `isActive`: Boolean flag (default `true`)
   - Unique: `(sourceGroupId, chatId)`

3. **`ForwardingLog`**: Tracks delivery history and guards against duplicate forwards.
   - `id`: UUID Primary Key
   - `sourceChatId`: BigInt
   - `sourceMessageId`: Int
   - `destinationGroupId`: Foreign Key referencing `DestinationGroup.id` (`onDelete: Cascade`)
   - `status`: `ForwardingStatus` enum (`SUCCESS`, `FAILED`)
   - `errorMessage`: Optional text describing failures
   - Unique: `(sourceChatId, sourceMessageId, destinationGroupId)`

### Prisma 7 Commands

- **Validate schema**:
  ```bash
  npx prisma validate
  ```
- **Apply migrations**:
  ```bash
  npx prisma migrate dev --name init_database
  ```
- **Generate Prisma Client**:
  ```bash
  npx prisma generate
  ```

---

## Source Group & Topic Detection

The system can monitor specific Telegram forum topics within course supergroups to identify new announcements.

### How It Works

1. **Registration**: An authorized administrator runs `/register_source` inside the course forum topic (or specifies the topic ID explicitly). The group's `chatId` and `topicId` are stored in the `SourceGroup` table.
2. **Detection**: Whenever a new message arrives in a group:
   - The bot extracts `chat.id` and `message_thread_id`.
   - Messages from private chats, unregistered groups, or non-topic messages are safely ignored.
   - If the `(chatId, topicId)` pair matches a registered source, the message is recognized and logged as a new announcement.
3. **Authorization**:
   - Only users whose IDs are defined in `ADMIN_USER_IDS` or users who are Administrators in the Telegram group can register sources.

### Bot Commands

| Command | Description | Permissions |
| :--- | :--- | :--- |
| `/start` | Introduces the bot and welcome message | Public |
| `/help` | Explains bot features and commands | Public |
| `/register_source [topicId] <name>` | Registers the current group topic as an announcement source | Admins Only |
| `/list_sources` | Displays all registered source groups and topics with their IDs | Admins Only |
| `/register_destination <source_id> <group_name>` | Registers the current student group as a destination linked to a source | Admins Only |
| `/list_destinations [source_id]` | Displays destinations (optionally filtered by source ID) | Admins Only |
| `/remove_destination <destination_id>` | Deactivates a destination group (`isActive: false`, preserves history) | Admins Only |
| `/activate_destination <destination_id>` | Reactivates a previously deactivated destination group | Admins Only |
| `/test_forward <destination_chat_id> [msg_id]` | Tests forwarding a single message to a destination (reply to message or pass ID) | Admins Only |

#### Usage Examples:

- **Register a Source Topic**:
  ```text
  /register_source Final Project Announcements
  ```
  *(or `/register_source 42 Final Project Announcements` with explicit topic ID)*

- **Register a Destination Group**:
  Run directly inside the student Telegram group:
  ```text
  /register_destination <source_id> Final Project Team 1
  ```

- **List Destinations**:
  ```text
  /list_destinations
  /list_destinations <source_id>
  ```

- **Deactivate / Reactivate Destination**:
  ```text
  /remove_destination <destination_id>
  /activate_destination <destination_id>
  ```

- **Test Forwarding a Message**:
  Reply to any announcement message in the source group:
  ```text
  /test_forward -1009876543210
  ```
  *(or pass the source message ID explicitly: `/test_forward -1009876543210 42`)*

---

## Announcement Distribution Service

The distribution service ([src/services/distribution.service.ts](file:///home/saw/Downloads/Announcement_Distribution/src/services/distribution.service.ts)) connects source-topic detection, active destination retrieval, and message forwarding into an end-to-end automated pipeline:

1. **Automatic Detection**: When an announcement is published in a registered source forum topic, the system automatically detects the source group and topic thread ID.
2. **Active Group Filtering**: Only active destinations (`isActive: true`) associated with that specific `sourceGroupId` receive the announcement. Inactive destinations and destinations associated with other source topics are excluded.
3. **Loop & Command Protection**:
   - Messages sent by any bot (`message.from.is_bot = true`) are ignored to prevent feedback loops.
   - The bot's own administrative updates are ignored.
   - Bot commands (starting with `/`) are ignored and not forwarded to destination groups.
4. **Resilience & Partial Failure Handling**:
   - Messages are forwarded sequentially to all active destinations.
   - Individual forwarding failures (e.g. `BOT_NOT_MEMBER`, `PERMISSION_DENIED`, `RATE_LIMITED`) do not stop delivery to the remaining destinations.
   - An in-memory structured delivery summary (`DistributionSummary`) records the total destinations, successful count, failed count, and individual destination outcomes.

---

## Message Forwarding Engine

The message forwarding engine ([src/services/forwarding.service.ts](file:///home/saw/Downloads/Announcement_Distribution/src/services/forwarding.service.ts)) enables native Telegram message forwarding:

1. **Native Forwarding**: Uses Telegram's `telegram.forwardMessage(...)` API. This preserves original sender/author attribution, supports all media formats (photos, documents, videos, text, voice, audio), and avoids costly media download/re-upload cycles.
2. **Error Taxonomy**: Telegram API errors are categorized into structured error types (`BOT_NOT_MEMBER`, `PERMISSION_DENIED`, `MESSAGE_NOT_FOUND`, `PROTECTED_CONTENT`, `RATE_LIMITED`, `INVALID_CHAT_ID`, `UNKNOWN_ERROR`) with clear explanations.
3. **Controlled Testing**: The `/test_forward` command allows administrators to test single-message forwarding safely without triggering distribution to all groups. Bot tokens are completely sanitized from logs and error messages.

---

## Media Types, Media Albums, and Telegram Message Edge Cases

The distribution pipeline natively supports different message types and Telegram-specific operational edge cases:

### 1. Supported Message Types
All message types are forwarded natively via Telegram Bot API without re-uploading or downloading files:
- **Text Announcements**: Plain text with formatting entities (bold, italic, monospace, links).
- **Photos**: Single photos with or without captions.
- **Documents**: PDFs, Word documents, slide decks, ZIP archives, spreadsheets.
- **Videos**: MP4/MOV videos with captions.
- **Audio Files**: MP3, podcasts, or music files.
- **Voice Messages**: OGG/Opus voice notes with waveforms preserved.
- **Video Messages (Video Notes)**: Circular round video clips.
- **Stickers**: Static, animated (TGS), and video stickers (WEBM).
- **Animations**: GIFs with captions.
- **Polls**: Regular and quiz polls.
- **Contacts, Locations, Venues, and Dice**: Embedded native Telegram objects.

### 2. Media Album Collection and Batching Strategy
Telegram delivers media group items (albums of photos or videos) as individual message updates rather than a single atomic update.
- **Sliding Debounce Window**: [src/services/album.service.ts](file:///home/saw/Downloads/Announcement_Distribution/src/services/album.service.ts) accumulates messages sharing the same `media_group_id` using a configurable sliding debounce window (default **500ms**).
- **Hard Ceiling**: A maximum ceiling (default **2500ms**) prevents indefinite waiting if network delays occur.
- **Trade-off Analysis**: A collection window of 500ms strikes the optimal balance between waiting for all updates to arrive over the network and maintaining near-instantaneous forwarding delivery.
- **Sequence Preservation**: Message IDs are sorted in strictly ascending order before forwarding.
- **Atomic Forwarding**: Uses Telegram's native `telegram.forwardMessages(destChatId, srcChatId, messageIds)` API, keeping the album grouped in destination groups.
- **Duplicate Prevention**: Memory cache of recently finalized `media_group_id` keys prevents late-arriving updates from re-triggering distribution.

### 3. Handling Telegram Forwarding Limitations & Protected Content
- **Protected Content**: Groups or channels with "Restrict saving content" enabled reject forwarding with `CHAT_FORWARDS_RESTRICTED`. The system classifies this error (`PROTECTED_CONTENT`), logs the event, and continues to remaining destinations without crashing.
- **Missing / Deleted Messages**: Handled via `MESSAGE_NOT_FOUND` without interrupting the batch.
- **Unauthorized / Removed Bot**: When a bot is kicked from a destination group, it is categorized as `BOT_NOT_MEMBER`, allowing other destinations to receive the announcement cleanly.

### 4. Rate-Limit Handling
- **Recognition**: Telegram Bot API 429 errors (`Too Many Requests: retry after X`) and `parameters.retry_after` are parsed automatically into `retryAfterSeconds`.
- **Sequential Backoff**: If rate-limited on a destination, the system pauses execution for `retryAfterSeconds` (capped at a safe ceiling of 10s) before attempting subsequent destinations.
- **Burst Mitigation**: A gentle delay (`interDestinationDelayMs = 50ms` in production, `0ms` in test mode) paces delivery across multi-group broadcasts.

---

## Manual Testing Checklist (Real Telegram Verification)

To test the system manually in live Telegram groups:

1. **Text Announcement**: Post a text message in the registered source topic; verify all active destination groups receive the forwarded message with source attribution.
2. **Photo with Caption**: Post a photo with an explanatory caption; verify destination groups receive the image with caption intact.
3. **Multiple Photos in One Album**: Post an album of 3–5 photos; verify that destinations receive the album grouped as a single media group and only once.
4. **PDF Document**: Upload a PDF file in the source topic; verify that students can download and open the document directly.
5. **Video**: Post a video with caption; verify video playback and caption are preserved in destinations.
6. **Voice Message**: Record and send a voice memo; verify audio playback in destination groups.
7. **Sticker**: Send a sticker; verify it appears in all destination groups.
8. **Protected Content**: Forward a message from a channel with restricted saving; verify the system logs `PROTECTED_CONTENT` and does not crash.
9. **Multi-Destination Album Delivery**: Verify an album reaches multiple registered groups concurrently.
10. **Partial Failure**: Remove the bot from one destination group; post an announcement and verify remaining destination groups still receive the message.
11. **Rate-Limit Handling**: Broadcast an announcement to multiple destinations; verify logs demonstrate steady pacing without Telegram 429 drops.
12. **Source Topic Isolation**: Register two source topics (e.g. Topic A and Topic B with separate destination groups); post in Topic A and verify Topic B destinations receive nothing.

---

## Known Reliability Limitations

1. **In-Memory Album Buffer**: Album collection is kept in memory. If the bot crashes during the 500ms collection window, pending album items are lost. (Persistent queuing will be addressed in future phases).
2. **Sequential Delivery Loop**: Delivery to multiple destinations occurs sequentially in the event loop. While simple and memory-efficient, distributing to hundreds of groups would benefit from a dedicated background worker queue (e.g. BullMQ / Redis).
3. **No Database Forwarding Audit Logs**: In accordance with Day 2 requirements, delivery results are returned in memory and not yet committed to the `ForwardingLog` database table.

---

## Destination Group Management

Destination groups represent the student project groups that receive announcements:
1. **One-to-Many Association**: Each destination group links to exactly one source topic via `sourceGroupId` in `DestinationGroup`. One source topic can distribute to dozens of destination groups.
2. **Execution Context**: `/register_destination` must be run directly inside the student Telegram group (private chat attempts are rejected).
3. **Soft Deactivation**: `/remove_destination` deactivates the destination (`isActive = false`) rather than deleting it. This preserves delivery history and audit logs while stopping future forwards until reactivated via `/activate_destination`.
4. **Permissions**: The bot must be added to each destination group and granted permission to send messages.

---

## Running the Application

### Development Mode (with hot-reloading via `tsx`):
```bash
npm run dev
```

### Production Mode (compiles and executes JavaScript):
```bash
npm run build
npm start
```

---

## Verification and Testing

To verify the bot setup end-to-end:

1. **Configure Token**: Add your BotFather token to `.env` (`TELEGRAM_BOT_TOKEN=...`).
2. **Start the Bot**: Run `npm run dev`. You should see:
   ```text
   Connecting to Telegram Bot API...
   Telegram Bot started successfully as @YourBotName (ID: 123456789)
   Bot is ready to receive /start and /help commands.
   ```
3. **Open Telegram**: Navigate to `https://t.me/<YourBotUsername>` or search for your bot.
4. **Test `/start`**: Send `/start`. The bot responds with the welcome message introducing the announcement system.
5. **Test `/help`**: Send `/help`. The bot responds with the help message detailing the bot's purpose for final-project announcement distribution.
6. **Test Graceful Shutdown**: Press `Ctrl+C` in your terminal. The bot safely terminates polling and exits cleanly.

### Automated Unit Tests

Run the test suite at any time:
```bash
npm test
```
The unit tests verify:
- Safe environment parsing and missing variable detection.
- Bot instance instantiation.
- Token sanitization in error logs.
- Command handler behavior for `/start` and `/help`.

---

## Security Considerations

- **No Hardcoded Tokens**: The bot token is loaded strictly from environment variables.
- **Error Redaction**: All logged errors pass through `sanitizeError` to strip bot tokens or credentials from log streams.
- **Git Safety**: `.env` is listed in `.gitignore` to prevent secret leaks to version control.
