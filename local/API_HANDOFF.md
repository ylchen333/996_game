# FLUX.2 Klein 9B — API Handoff

Image-editing API. You send an image + a text prompt; you get back an edited PNG.

## Endpoint

```
POST {BASE_URL}/generate
Content-Type: multipart/form-data
```

`BASE_URL` is the Modal web URL: https://steph--flux2-klein-9b-web-fluxmodel-web.modal.run/

Get the exact value from whoever deployed it (`modal deploy flux_web_api.py` prints it), or `modal app list`. No auth — do not send an Authorization header.

- Interactive docs / schema: `GET {BASE_URL}/docs`
- Browser UI (not needed for programmatic use): `GET {BASE_URL}/`

## Request (multipart form fields)

| Field                 | Type              | Required | Default | Notes |
|-----------------------|-------------------|----------|---------|-------|
| `image`               | file              | yes      | —       | The input image to edit. Any common format (jpg/png/webp). |
| `prompt`              | string            | yes      | —       | What edit to make. Free text. |
| `num_inference_steps` | int               | no       | `4`     | Distilled model; 4 is the sweet spot. Higher = slower, rarely better. |
| `guidance_scale`      | float             | no       | `1.0`   | Keep at 1.0 for this distilled model. |
| `seed`                | int               | no       | random  | Set for reproducible output. |
| `height`              | int               | no       | auto    | Output height in px. Omit to auto-size from input (capped at 1024). |
| `width`               | int               | no       | auto    | Output width in px. Omit to auto-size. |
| `use_canny`           | bool              | no       | `false` | Adds canny-edge conditioning to better preserve structure. |
| `canny_low`           | int               | no       | `100`   | Only relevant if `use_canny=true`. |
| `canny_high`          | int               | no       | `200`   | Only relevant if `use_canny=true`. |

(Ignore any `mask` field for now — do not send it.)

## Response

- **200**: raw PNG bytes, `Content-Type: image/png`. Write the body straight to a `.png` file. Output is roughly the input aspect ratio, max side 1024.
- **422**: malformed request (missing `image` or `prompt`, wrong types).
- **5xx**: model/server error.

## Examples

### curl

```bash
curl -X POST "$BASE_URL/generate" \
  -F "image=@input.jpg" \
  -F "prompt=Change the background to a snowy environment, taken on an iphone" \
  -F "seed=42" \
  -o output.png
```

### Python (requests)

```python
import requests

BASE_URL = "https://<workspace>--flux2-klein-9b-web-fluxmodel-web.modal.run"

with open("input.jpg", "rb") as f:
    resp = requests.post(
        f"{BASE_URL}/generate",
        files={"image": ("input.jpg", f, "image/jpeg")},
        data={
            "prompt": "Change the background to pure white studio lighting",
            "seed": 42,                 # optional
            "num_inference_steps": 4,   # optional
        },
        timeout=300,
    )
resp.raise_for_status()
with open("output.png", "wb") as out:
    out.write(resp.content)
```

Note: form values are strings on the wire — send numbers as-is in `data=` (requests stringifies them); the server coerces types.

## Latency & reliability notes

- **First call after idle is slow** (cold start): the GPU container boots and loads the 9B model — expect **up to a few minutes**. Set your client timeout to **300s** and don't treat a slow first response as failure.
- After warm-up, a call is roughly **1–2s** (inference is sub-second; the rest is image encode + transfer). The container stays warm for ~5 min after the last request, then scales down.
- Requests are processed on a single GPU; heavy parallel load will queue. Prefer sequential or lightly-concurrent calls.
- Idempotent: same `image` + `prompt` + `seed` → same output. Safe to retry on 5xx/timeout.
