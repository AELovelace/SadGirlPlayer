# SadGirlPlayer

A Discord bot that joins the same server voice channel as the user who requested playback and relays a live HLS `.m3u8` stream through FFmpeg.

## Requirements

- Windows with Node.js 22.12.0 or newer
- A Discord bot token
- A server where the bot can read messages, connect to voice, and speak
- FFmpeg is bundled through `ffmpeg-static` by default, but you can override it with `FFMPEG_PATH`

## Setup

1. Copy [.env.example](.env.example) to `.env`.
2. Fill in `DISCORD_TOKEN`.
3. Optionally set `DEFAULT_STREAM_URL` to a public live `.m3u8` URL.
4. Install dependencies with `npm install`.
5. Start the bot with `npm start`.

## Discord bot settings

Enable these privileged intents in the Discord Developer Portal:

- Message Content Intent
- Server Members Intent is not required for the current design

Invite the bot with permissions that cover:

- View Channels
- Send Messages
- Read Message History
- Connect
- Speak

## Commands

- `sb!play` — Join your current voice channel and play the configured default stream URL
- `sb!play <url>` — Join your current voice channel and play the supplied URL
- `sb!stop` — Stop playback and leave voice
- `sb!help` — Show command help

## Autonomous Chatbot Mode (Lumi)

The bot can also run as a general-purpose chat participant in specific text channels.

Behavior defaults in this implementation:

- Channel whitelist only (`CHATBOT_CHANNEL_IDS`)
- 20% baseline unsolicited reply chance (`CHATBOT_REPLY_CHANCE=0.2`)
- Additional reply triggers for direct mentions/replies and conversational interest heuristics
- Conservative per-channel cooldown (`CHATBOT_COOLDOWN_MS=15000`)
- Sliding context window per channel (`CHATBOT_CONTEXT_MESSAGES=20`)

### LLM Infrastructure

Set these env values to use your two Qwen endpoints with round-robin + failover:

- `CHATBOT_MODEL=qwen2.5:7b`
- `LLM_ENDPOINTS=http://172.27.23.252:11434,http://172.27.23.252:11435`
- `LLM_TIMEOUT_MS=25000`
- `LLM_RETRY_LIMIT=2`
- `LLM_RETRY_BASE_DELAY_MS=1000`

If one endpoint fails, requests automatically retry and fail over to the other endpoint.

### Persistent Long-Term Memory

Chat context and runtime Lumi settings now persist to disk:

- `CHATBOT_MEMORY_FILE=data/chatbot-memory.json`
- `CHATBOT_MEMORY_FLUSH_MS=5000`

This stores per-channel sliding history and control-plane runtime settings across restarts.

### Slash Command Control Plane (Admin UI)

Enable slash commands to manage Lumi at runtime:

- `/lumi-status`
- `/lumi-toggle enabled:true|false`
- `/lumi-set reply_chance:<0..1> cooldown_ms:<n> context_messages:<n> max_response_chars:<n>`
- `/lumi-channel action:add|remove|list channel:#channel`

Control plane settings:

- `CONTROL_PLANE_ENABLED=true`
- `SLASH_GUILD_ID=<guild-id>` for fast guild-scoped command registration (recommended)
- `ADMIN_USER_IDS=<comma-separated-user-ids>` for explicit admin override

Users with Manage Server permission can use these commands by default.

### Moderation Stack

Autonomous input/output moderation is enabled by default:

- Input filtering for empty/oversized messages and optional blocklist terms
- Optional Discord invite-link blocking
- Output mention-count cap and output-length cap

Settings:

- `MODERATION_ENABLED=true`
- `MODERATION_BLOCKLIST=<comma-separated-terms>`
- `MODERATION_MAX_INPUT_CHARS=750`
- `MODERATION_MAX_OUTPUT_CHARS=450`
- `MODERATION_MAX_MENTIONS=3`
- `MODERATION_BLOCK_INVITE_LINKS=true`

### Suggested First-Pass Tuning

- Lower noise: reduce `CHATBOT_REPLY_CHANCE` to `0.1`
- Higher activity: raise `CHATBOT_REPLY_CHANCE` to `0.3`
- Longer answers: raise `CHATBOT_MAX_RESPONSE_CHARS`
- Faster turn-taking: lower `CHATBOT_COOLDOWN_MS`

## Notes

- The bot supports simultaneous playback in multiple guilds. Each guild has its own independent voice session and stream pipeline.
- Each guild can have the bot in at most one voice channel at a time. Starting a new `sb!play` in the same guild replaces the previous session.
- The bot expects public HLS inputs. Protected streams that need custom headers, cookies, or tokens are not implemented yet.
- Auto-reconnect is included for dropped stream and voice failures, with bounded retry counts per session.
- The bot uses FFmpeg to strip video and encode to Opus before sending audio into Discord voice.
- On shutdown (SIGINT/SIGTERM), all active sessions across every guild are stopped cleanly before the process exits.
