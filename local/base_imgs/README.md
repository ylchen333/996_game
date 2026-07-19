# Story beats manifest

`events.json` is a JSON array of story beats, in play order. Any number of beats
works. Place the four images for each beat in this directory and reference them
by filename (with extension, no nested paths).

```json
[
  {
    "eventName": "Throw",
    "narrative": "The Boss throws a projectile at me. I hurl a [PlayerKeyword] back at him.",
    "validationTestPrompt": "If throwing [PlayerKeyword] at a person would cause a lot of pain return false, else return true",
    "successPrompt": "Write a success answer. The manager is happy with your choice of [PlayerKeyword] because...",
    "negativePrompt": "Write a negative answer. The manager is unhappy with your choice of [PlayerKeyword] because...",
    "imageEditPrompt": "Change the black ball being thrown in the air in this image with a [PlayerKeyword]",
    "images": {
      "context": "1-1.png",
      "action": "1-2.png",
      "positiveOutcome": "1-3.png",
      "negativeOutcome": "1-4.png"
    }
  }
]
```

Rules:

- `[PlayerKeyword]` is replaced server-side with the player's submitted word in
  every prompt field. In `narrative` the client renders it as a blank (`___`).
- `validationTestPrompt` must return **true for the desirable answer** — true
  always maps to the positive outcome. Spell out both branches ("...return
  false, else return true").
- Double quotes inside prompt text must be escaped as `\"`.
- Image roles: `context` shows while the player reads and types; `action` is
  sent to the FLUX edit API with `imageEditPrompt`; `positiveOutcome` and
  `negativeOutcome` are shown as-is with the Gemini-generated text overlaid.
- All six text fields and all four image filenames are required; the server
  rejects the manifest otherwise.
