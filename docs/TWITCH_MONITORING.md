# Twitch monitoring status

## Implemented
- Twitch OAuth tokens encrypted with AES-256-GCM and persisted in Supabase (`twitch_connections`) when the **new** OAuth callback is used.
- Refresh helper `lib/twitch-auth.ts` for future chat EventSub subscription.
- Twitch live discovery endpoint `/api/cron/twitch/discover` with a 10-minute GitHub Actions schedule.
- Chat signal analyzer and authenticated ingestion endpoint `POST /api/cron/twitch/analyze`. It stores candidate moments in `twitch_chat_moments`, without retaining raw chat messages.

## Not yet live
- **No real-time chat collector has been deployed.** The ingest endpoint needs a persistent Twitch EventSub chat subscriber or another permitted chat source. Scheduling discovery every ten minutes does not read chat.
- OAuth tokens from **previous** browser-cookie callback are not in Supabase. A new Twitch authorization must occur after the new callback is deployed.
- No Twitch VOD/clip retrieval or MP4 generation or automated posting is implemented.
- Streamer priorities are configured as names, but Twitch Helix `user_login` requires the exact channel login, not display name. Set `RADAR_PRIORITY_CHANNELS` to verified logins to avoid missing priority streams.
- GitHub Actions schedules can be delayed; ten minutes is best-effort.
- A stream search can discover GTA VI channels based on their titles but may also include unrelated or mislabeled streams.

## Required configuration
`TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `CRON_SECRET` in Vercel. GitHub Actions requires `RADAR_BASE_URL` and `CRON_SECRET`.

No paid LLM tokens are used in these routes.
