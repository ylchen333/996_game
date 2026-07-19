# Event image pairs

Place event images in this directory and list them in `events.json`:

```json
[
  {
    "event": "core-competency",
    "image_1": "core-competency-before.png",
    "image_2": "core-competency-edit-base.png"
  }
]
```

`event` must match an event `id` from `public/game-engine.js`. Use filenames only,
not nested paths. `image_1` is displayed while the player reads and types;
`image_2` is sent to the image-edit API with the submitted word.
