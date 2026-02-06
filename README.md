# swe-wod
Software Engineering Word of the Day

https://swe-wod.com

## Development

### Site (static)
The site is a static page served from `public/`.

1. Edit files in `public/`.
2. Preview locally:
   - `npm run preview`

### WOD data
`src/generateWod.ts` builds `public/wod.json`.

1. Ensure `.env` is set for OpenAI usage.
2. Generate:
   - `npm run wod`

### Push Worker
Worker code lives in `wod-push/`.

1. Edit files in `wod-push/src/`.
2. Local dev (optional):
   - `cd wod-push`
   - `npx wrangler dev`
3. Deploy:
   - `npm run deploy:wrangler`

### Required Worker Secrets
Set these in Cloudflare (and in local dev):
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `BROADCAST_TOKEN`

### Useful Endpoints
- `POST /subscribe` (stores subscription)
- `POST /broadcast` (auth with `BROADCAST_TOKEN`)
- `GET /debug` (subscription + last broadcast metadata)
- `GET /vapid` (public key for client)
