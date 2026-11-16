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
