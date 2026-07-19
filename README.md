# 996

A dependency-free Node.js prototype of the narrative loop in `local/outline.png`.
Players complete each sentence with a noun. A positive match advances the story;
a negative match resets it to scene zero. The UI exposes four explicit states:
unanswered, answered-positive, answered-negative, and final-win.

## Run locally

Requires Node.js 18 or newer.

```sh
npm start
```

Then open <http://localhost:3000>. During development, `npm run dev` restarts the
server when a file changes. Run the engine tests with `npm test`.

## Customize the story

Edit `EVENTS` in `public/game-engine.js`. Each event contains narrative copy, a
sentence prompt, positive and negative examples, feedback, and an `imagePrompt`.

The running game sends each sentence and submitted noun to the server-side
`/api/validate` endpoint. That endpoint asks Gemini for exactly `True` or `False`;
anything else fails closed as `False` and is logged by the server. Set
`GEMINI_API_KEY` in `.env.local` before playing. The earlier local cosine and
`angel`/`devil` debug implementations remain in `classifyAnswer()` for isolated
testing, but debug mode is disabled while Gemini validation is active.

The `imagePrompt` field and state symbol remain as a fallback when an event image
is missing or cannot be loaded.

## Event images

Put base-image pairs in `local/base_imgs` and configure `events.json` there. The
unanswered event displays `image_1`. After submission, the server sends `image_2`
and the player's word to the configured FLUX edit endpoint while Gemini validates
the word in parallel. The edited PNG replaces the scene when both operations
settle. Image requests allow a five-minute timeout to accommodate Modal cold
starts. See `local/base_imgs/README.md` for the manifest shape.

Provider placeholders live in `.env.local` (ignored by git), with safe names in
`.env.example`. Never put API keys in browser-side files.
