# 996

A dependency-free Node.js narrative game. Players complete each story beat's
sentence with a noun. Gemini judges the word against a per-beat validation rule
and writes the outcome narration; a FLUX endpoint edits the beat's action image
to include the player's word.

## Run locally

Requires Node.js 18 or newer.

```sh
npm start
```

Then open <http://localhost:3000>. During development, `npm run dev` restarts the
server when a file changes. Run the engine tests with `npm test`.

Set `GEMINI_API_KEY` in `.env.local` before playing (copy `.env.example`).
Provider placeholders live in `.env.local` (ignored by git). Never put API keys
in browser-side files.

## Story data

All story content lives in `local/base_imgs/events.json` — nothing is hardcoded,
so any number of story beats works. Each beat has six text fields and four
images (see `local/base_imgs/README.md` for the full schema):

- `eventName` — unique identifier
- `narrative` — the on-screen sentence; `[PlayerKeyword]` marks the blank
- `validationTestPrompt` — the true/false rule Gemini applies to the word.
  True must map to the desirable answer.
- `successPrompt` / `negativePrompt` — Gemini prompts that write the outcome text
- `imageEditPrompt` — the FLUX edit instruction
- `images` — `context`, `action`, `positiveOutcome`, `negativeOutcome` filenames

The literal token `[PlayerKeyword]` in any prompt is replaced server-side with
the submitted word. Prompts never reach the browser; the client only receives
`eventName` and `narrative` from `/api/events`.

## Game flow

1. The context image is shown with the narrative overlaid; the player types a noun.
2. The action image plus `imageEditPrompt` go to the FLUX edit endpoint while
   Gemini validates the word and writes outcome text in parallel.
3. The edited action image is shown with a Continue button.
4. Continue reveals the positive or negative outcome image with the generated
   text overlaid. Positive offers Next (next beat, or the win screen after the
   last one); negative offers Try Again (same beat, attempt counter increments).

Validation fails closed: any Gemini error or non-True answer counts as False.
Image requests allow a five-minute timeout to accommodate Modal cold starts; if
the edit fails, the unedited action image is shown instead.
