# Discord relay setup

Status: the Discord relay is implemented and covered by synthetic tests. A maintainer's setup passed real read-only permission checks, a manual-channel smoke check and a Gateway handshake. No real followed announcement has been observed yet, so Follow delivery, source identity/attribution and edit/delete behavior remain unverified. All steps below are performed by you in your own Discord account.

## 1. Private relay server and Follow

In Discord, use Add a Server → Create My Own and name it **Calendar Intelligence Hub**. Keep it private; do not distribute invites. Create ordinary text channels **calendar-feed** and **testing**. [Discord server setup](https://support.discord.com/hc/en-us/articles/204849977-How-do-I-create-a-server)

In the original Announcement channel, click **Follow**, select your new server and **calendar-feed**, then confirm. You need Manage Webhooks in your own destination channel; do not grant that permission to the bot. Do not change the original server. This receives only published announcements, not all its chat/history. If no post arrives, do not republish/edit someone else's announcement or treat absence as an extraction result. [Follow instructions](https://support.discord.com/hc/en-us/articles/360028384531-Channel-Following-FAQ)

## 2. Create the bot

Open the [Discord Developer Portal](https://discord.com/developers/applications), create an application named **Calendar Intelligence Hub**, then open its **Bot** settings. Under Privileged Gateway Intents enable **Message Content Intent** only; leave Server Members and Presence off. Keep the bot non-public if that option is available. Leave OAuth2 code-grant requirements off for this bot-token installation; no public interactions endpoint, client secret or user OAuth login is needed. Do not generate or share credentials in chat. [Official bot setup](https://docs.discord.com/developers/quick-start/getting-started)

In Installation, enable **Guild Install** for your own server. Use bot scope only for this read-only Gateway app; commands/user installation are unnecessary. For bot permissions choose only **View Channels** and **Read Message History**. If the portal's installation shortcut adds unrelated scopes/permissions, use OAuth2 → URL Generator with **bot** and just those two permissions. Copy its generated invite link locally and install only into your private server. Do not choose Administrator, Manage Server, Manage Roles, Manage Webhooks, Send Messages or moderation permissions. [Installation model](https://docs.discord.com/developers/resources/application#installation-context), [permission definitions](https://docs.discord.com/developers/topics/permissions)

Restrict the bot's channel access: deny View Channel for its role on unrelated channels/categories (including testing), then allow View Channel + Read Message History on calendar-feed. Ensure its global role/effective channel permissions grant no unrelated write/management capabilities. Keep calendar-feed dedicated to Follow deliveries. Application filtering will also enforce the exact guild/channel allowlist; permission filtering is an additional boundary.

## 3. Save local configuration privately

In Discord's User Settings → Advanced enable **Developer Mode**. Right-click the private server → Copy Server ID; right-click calendar-feed → Copy Channel ID. Only that feed channel belongs in the production allowlist; testing does not. [Developer Mode and IDs](https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID)

Generate/reset the bot token yourself on the Developer Portal Bot page. Enter the token and IDs directly in the existing ignored active configuration file:

`<repository>/.env`

Append these names using your actual local values (the blanks below are not working credentials):

```dotenv
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
DISCORD_CHANNEL_IDS=
```

For one channel, DISCORD_CHANNEL_IDS is its exact ID; multiple allowed feeds will use comma-separated IDs. Preserve every Google/Microsoft/database setting and TOKEN_ENCRYPTION_KEY exactly. Do not overwrite .env with a template. Do not stage/commit it, copy it into other checkouts, paste values into chat or share screenshots containing credentials. The runtime starts only after the Discord migration is applied and the configured feed is connected to an authenticated workspace in Connections. Configuration alone never chooses an owner.

## 4. Optional read-only check

`npm run discord:smoke` loads the Discord variables from `.env`, checks bot access and reads the first configured channel in memory and prints only sanitized categories and counts. It creates no database records, Calendar events or Discord messages. Do not share IDs, the token, message bodies, invite URLs or raw payloads from any check. A real followed announcement is still required before relying on identity/attribution. Use an existing harmless published announcement; never modify another community's content for a test.

Current privileged-access rules and research date are in [discord-research.md](discord-research.md). The setup guide does not claim the intent, installation or Follow works until verified.

## Current operational limits

The implementation imports configured Follow posts automatically while the backend runs. It does not import ordinary manually pasted feed posts. The standalone manual smoke utility processes those only in memory and cannot create production records or Calendar events. Recovery reads at most 100 recent messages per selected channel, with incomplete/capped coverage reported. Reconnect is explicit after a blocked/exhausted connection; there is no background polling scheduler. Source changes require checking the latest announcement in Discord and confirming the reviewed decision. Approved snapshots and existing Calendar events are not automatically changed.
