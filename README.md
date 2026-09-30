# FaceStyle AI

> "Find the style that fits your face."

A mobile-first web app that takes a selfie and returns AI-estimated hairstyle,
beard, and grooming recommendations. No login required for this first
version. Zero npm dependencies — the whole backend runs on Node's built-in
`http` module.

## Quick start

```bash
cd facestyle-ai
cp .env.example .env
# open .env and paste in your Anthropic API key
node server.js
```

Then open **http://localhost:3000** on your phone or desktop (use your
computer's LAN IP instead of `localhost` to test on a real phone).

No `npm install` is required — there are no runtime dependencies. If you'd
rather run it without editing `.env`, you can also do:

```bash
ANTHROPIC_API_KEY=sk-ant-... node server.js
```

### Without an API key

The app still loads and is fully explorable. The home page and upload screen
show a clear banner: *"AI analysis isn't connected yet. Add your AI API key
to enable live analysis."* No fake results are ever shown — this is by
design (see `services/aiService.js`).

## What's real vs. what's a placeholder

| Feature | Status |
|---|---|
| Upload (camera / gallery / drag-drop) | ✅ Fully functional |
| Client-side validation (file type/size) | ✅ Fully functional |
| AI face analysis | ✅ Real, via Claude's vision API (`ANTHROPIC_API_KEY`) |
| Face-not-detected / multiple-faces handling | ✅ Real — determined by the vision model itself, not a hardcoded rule |
| Hairstyle recommendations (5) | ✅ Real, generated from your actual analysis |
| Beard recommendations (4) | ✅ Real, generated from your actual analysis |
| Grooming guide | ✅ Real — deterministic, rule-based on your actual analysis (no AI call needed, no invented facts) |
| Style library ("Explore Styles") | ✅ Real, static reference content |
| Hairstyle / beard image preview ("Try This Style") | ✅ **Implemented**, via Google's Gemini 2.5 Flash Image model. Set `IMAGE_EDIT_API_KEY` in `.env` to activate it — no code changes needed. Without a key, it still never fakes a result: it shows a clear "preview service not connected" message instead. |

This matches the spec's explicit instruction: **never fake an analysis or a
generated image.** If Gemini's safety filters decline an edit, or the
service errors out, the app surfaces that honestly rather than substituting
a fake image.

## Enabling hairstyle/beard image preview

1. Get a free API key at https://aistudio.google.com/apikey
2. Add it to `.env`:
   ```
   IMAGE_EDIT_API_KEY=your-gemini-key-here
   ```
3. Restart the server. That's it — `IMAGE_EDIT_PROVIDER` defaults to
   `gemini` and `IMAGE_EDIT_MODEL` defaults to `gemini-2.5-flash-image`.

The prompts sent to the model (see `buildHairstylePrompt` /
`buildBeardPrompt` in `services/aiService.js`) explicitly instruct it to
preserve identity, facial structure, skin tone, and proportions, and to
change only the hair or facial hair.

### Adding a different provider later

`callImageEditProvider()` in `services/aiService.js` dispatches on
`IMAGE_EDIT_PROVIDER`. To add another provider, write a `callXImageEdit()`
function following the same shape as `callGeminiImageEdit()` (take the
image + prompt, return a `data:image/...;base64,...` string or throw an
`AppError`), and add a `case` for it in `callImageEditProvider()`. Nothing
in the routes or frontend needs to change.

## Architecture

```
server.js                 # HTTP server + routing (zero dependencies)
services/
  aiService.js             # ALL AI calls live here — the swappable AI layer
  styleLibrary.js           # Static reference content for "Explore Styles"
  errors.js                 # Typed AppError -> clean HTTP responses
  envLoader.js               # Minimal .env file reader
public/
  index.html                 # Single-page app shell (all screens)
  styles.css                  # Mobile-first, light/dark aware
  app.js                        # Client logic, fetch calls, upload, slider
```

The AI layer exposes exactly these functions, matching the spec:

```js
analyzeFace(image)
getHairstyleRecommendations(analysis)
getBeardRecommendations(analysis)
generateHairstylePreview(image, hairstyle)
generateBeardPreview(image, beardStyle)
```

Swap the vision model, add a different provider, or add the image-editing
API later — nothing outside `services/aiService.js` needs to change.

## Privacy & data handling

- No accounts, no login.
- The uploaded photo and analysis are kept **only in the browser's memory**
  for the current session — never written to localStorage, never persisted
  in a database, and never logged on the server.
- "Delete My Photo" clears the in-memory photo and results immediately.
- A privacy notice is shown next to the upload control.

## Error handling

The backend maps every failure to a specific, human-readable message (no
raw provider errors or API keys are ever exposed): invalid image, image too
large, no face detected, multiple faces, provider not configured, provider
auth failure, rate limiting, timeouts, and network errors.

## Testing notes

This build was smoke-tested with the server running locally:
- Loads with no API key configured → shows the fallback banner, no fake data.
- `/api/analyze` correctly short-circuits to the fallback message when
  `ANTHROPIC_API_KEY` is unset.
- `/api/preview/hairstyle` and `/api/preview/beard` return a clear
  "not configured" response when `IMAGE_EDIT_API_KEY` is unset, and were
  also tested against the real Gemini endpoint (with an invalid key) to
  confirm the request is built correctly and auth failures are mapped to a
  clean error rather than a raw provider response.
- `/api/styles` returns the static style library.
- Static assets and client-side routing/fallback serve correctly.
- Upload validation rejects non-image files and oversized files client-side.

To fully test the live-analysis path, add a real `ANTHROPIC_API_KEY` and
upload a real selfie.
