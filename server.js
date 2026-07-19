import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, normalize, resolve } from "node:path";
import { createServer } from "node:http";

// A tiny environment-file loader keeps this prototype dependency-free. It only
// fills missing values, so real environment variables always take precedence.
function loadEnvironment(file = ".env.local") {
  if (!existsSync(file)) return;
  const text = statSync(file).isFile() ? readFileSync(file, "utf8") : "";
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
loadEnvironment();

const publicDirectory = join(process.cwd(), "public");
const baseImagesDirectory = join(process.cwd(), "local", "base_imgs");
const imageManifestPath = join(baseImagesDirectory, "events.json");
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

const VALIDATION_PROTOCOL = `You are a true/false semantic validation algorithm. For a word to have positive potention, it needs to fit a validation rule that is inferred from the details in the sentences that preced and suceed it. The validation rule also needs to follow the theme of the game: training to become the perfect employee. Return True if the input word passes the validation test generated and False if the input doesn't pass. Answers will only be one word: either "True" or "False"

Example: I need to leave my desk to throw up from sheer stress, but my chair has a weight sensor that logs unpaid absences. To fool the system into thinking my body is still producing value, I place a [] on the seat cushion.

Validation test: "Return true if this object is the same weight as the average human (100 - 200 pounds), else return false"`;

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readImageManifest() {
  if (!existsSync(imageManifestPath)) return [];
  const manifest = JSON.parse(readFileSync(imageManifestPath, "utf8"));
  if (!Array.isArray(manifest)) throw new Error("local/base_imgs/events.json must contain an array.");
  return manifest;
}

function getEventImages(eventId) {
  const entry = readImageManifest().find((item) => item?.event === eventId);
  if (!entry) throw new ValidationServiceError(`No image pair is configured for event '${eventId}'.`, 404, "IMAGE_NOT_CONFIGURED");
  return entry;
}

/** Resolve only simple filenames inside base_imgs; manifest paths cannot escape it. */
function resolveBaseImage(filename) {
  if (typeof filename !== "string" || basename(filename) !== filename) {
    throw new ValidationServiceError("The image manifest contains an unsafe filename.", 500, "INVALID_IMAGE_PATH");
  }
  const filePath = resolve(baseImagesDirectory, filename);
  if (!filePath.startsWith(`${resolve(baseImagesDirectory)}/`) || !existsSync(filePath)) {
    throw new ValidationServiceError(`Base image '${filename}' was not found.`, 404, "IMAGE_NOT_FOUND");
  }
  return filePath;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 10_000) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

class ValidationServiceError extends Error {
  constructor(message, status = 502, code = "GEMINI_ERROR") {
    super(message);
    this.name = "ValidationServiceError";
    this.status = status;
    this.code = code;
  }
}

function geminiHttpError(status) {
  if (status === 400) return new ValidationServiceError("Gemini rejected the validation request.", 502, "BAD_GEMINI_REQUEST");
  if (status === 401 || status === 403) return new ValidationServiceError("Gemini authentication failed. Check the API key.", 503, "AUTHENTICATION_ERROR");
  if (status === 404) return new ValidationServiceError("The configured Gemini model is unavailable.", 503, "MODEL_UNAVAILABLE");
  if (status === 429) return new ValidationServiceError("Gemini rate limit reached. Try again shortly.", 429, "RATE_LIMITED");
  if (status >= 500) return new ValidationServiceError("Gemini is temporarily unavailable.", 503, "SERVICE_UNAVAILABLE");
  return new ValidationServiceError("Gemini validation failed.");
}

/**
 * Ask Gemini to infer a validation rule from the whole sentence and judge the
 * submitted noun. The API key stays on the server and is never sent to clients.
 */
async function validateWithGemini(sentence, word) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Gemini validation failed: GEMINI_API_KEY is not configured.");
    throw new ValidationServiceError("Gemini API key is not configured.", 503, "MISSING_API_KEY");
  }

  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS) || 15_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{ text: `${VALIDATION_PROTOCOL}\n\nSentence to validate: ${sentence}\nInput word: ${word}\n\nReturn only True or False.` }]
        }],
        generationConfig: {
          temperature: 0,
          // Minimal reasoning is sufficient for a binary classification. A
          // generous cap prevents reasoning tokens from truncating the verdict.
          maxOutputTokens: 512,
          thinkingConfig: { thinkingLevel: "minimal" }
        }
      })
      }
    );
  } catch (error) {
    if (error.name === "AbortError") {
      throw new ValidationServiceError(`Gemini timed out after ${timeoutMs}ms.`, 504, "TIMEOUT");
    }
    throw new ValidationServiceError("Could not connect to Gemini.", 503, "NETWORK_ERROR");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = (await response.text()).slice(0, 500);
    console.error(`Gemini validation request failed (${response.status}): ${errorText}`);
    throw geminiHttpError(response.status);
  }

  const payload = await response.json();
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  // A Gemini response can contain multiple parts. Thought-summary parts must not
  // be interpreted as the final validation answer.
  const modelAnswer = parts
    .filter((part) => part?.text && part.thought !== true)
    .map((part) => part.text)
    .join("")
    .trim() || undefined;

  // Always expose the model's raw text in the Node process log while the
  // validation protocol is being tuned. JSON.stringify makes whitespace,
  // missing values, and unexpected formatting visible without ambiguity.
  console.log("Gemini API returned:", JSON.stringify(modelAnswer));
  console.log("Gemini finish reason:", payload?.candidates?.[0]?.finishReason || "unknown");

  if (modelAnswer === undefined) {
    console.error("Gemini response contained no answer text:", JSON.stringify({
      finishReason: payload?.candidates?.[0]?.finishReason,
      promptFeedback: payload?.promptFeedback,
      usageMetadata: payload?.usageMetadata,
      parts
    }));
  }

  if (modelAnswer === "True") return true;
  if (modelAnswer === "False") return false;

  // Fail closed: prose, markdown, empty responses, and alternate casing are all
  // invalid because the protocol promises exactly one of two words.
  console.error("Gemini returned an invalid answer:", JSON.stringify(modelAnswer));
  return false;
}

/**
 * Send image_2 and the player's word to the FLUX edit service. The returned PNG
 * stays in memory only long enough to stream it back to the current browser.
 */
async function editEventImage(eventId, word) {
  const { image_2: editImageName } = getEventImages(eventId);
  const editImagePath = resolveBaseImage(editImageName);
  const baseUrl = (process.env.IMAGE_EDIT_BASE_URL || "https://steph--flux2-klein-9b-web-fluxmodel-web.modal.run").replace(/\/$/, "");
  const timeoutMs = Number(process.env.IMAGE_EDIT_TIMEOUT_MS) || 300_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const form = new FormData();
  const mimeType = mimeTypes[extname(editImagePath)] || "application/octet-stream";
  form.append("image", new Blob([readFileSync(editImagePath)], { type: mimeType }), basename(editImagePath));
  form.append("prompt", `Edit the scene so the physical object used by the employee is a ${word}. Preserve the original composition, characters, lighting, and visual style.`);
  form.append("num_inference_steps", "4");
  form.append("guidance_scale", "1.0");

  try {
    const apiResponse = await fetch(`${baseUrl}/generate`, {
      method: "POST",
      signal: controller.signal,
      body: form
    });
    if (!apiResponse.ok) {
      const detail = (await apiResponse.text()).slice(0, 500);
      console.error(`Image edit request failed (${apiResponse.status}): ${detail}`);
      const status = apiResponse.status === 422 ? 502 : 503;
      throw new ValidationServiceError("The image edit service rejected the request.", status, "IMAGE_EDIT_FAILED");
    }
    const contentType = apiResponse.headers.get("content-type") || "";
    if (!contentType.includes("image/png")) {
      throw new ValidationServiceError("The image edit service returned a non-PNG response.", 502, "INVALID_IMAGE_RESPONSE");
    }
    return Buffer.from(await apiResponse.arrayBuffer());
  } catch (error) {
    if (error instanceof ValidationServiceError) throw error;
    if (error.name === "AbortError") {
      throw new ValidationServiceError(`Image generation timed out after ${timeoutMs}ms.`, 504, "IMAGE_TIMEOUT");
    }
    throw new ValidationServiceError("Could not connect to the image edit service.", 503, "IMAGE_NETWORK_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);

  if (request.method === "GET" && pathname === "/api/event-image") {
    try {
      const url = new URL(request.url, "http://localhost");
      const entry = getEventImages(url.searchParams.get("event"));
      const filePath = resolveBaseImage(entry.image_1);
      response.writeHead(200, {
        "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-cache"
      });
      createReadStream(filePath).pipe(response);
    } catch (error) {
      const status = error instanceof ValidationServiceError ? error.status : 500;
      sendJson(response, status, { code: error.code || "IMAGE_MANIFEST_ERROR", error: error.message });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/edit-image") {
    try {
      const { event: eventId, word } = await readJson(request);
      if (typeof eventId !== "string" || typeof word !== "string" || !word.trim() || word.length > 40) {
        sendJson(response, 400, { code: "INVALID_IMAGE_INPUT", error: "An event and input word are required." });
        return;
      }
      const png = await editEventImage(eventId, word.trim());
      response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      response.end(png);
    } catch (error) {
      console.error("Image generation failed:", error);
      const status = error instanceof ValidationServiceError ? error.status : 500;
      sendJson(response, status, { code: error.code || "IMAGE_INTERNAL_ERROR", error: error.message || "Image generation failed." });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/validate") {
    try {
      const { sentence, word } = await readJson(request);
      if (typeof sentence !== "string" || typeof word !== "string" || !word.trim() || word.length > 40) {
        sendJson(response, 400, { positive: false, error: "A sentence and input word are required." });
        return;
      }
      const positive = await validateWithGemini(sentence.slice(0, 2_000), word.trim());
      sendJson(response, 200, { positive });
    } catch (error) {
      console.error("Gemini validation failed:", error);
      if (error instanceof SyntaxError) {
        sendJson(response, 400, { positive: false, code: "INVALID_JSON", error: "The request body is not valid JSON." });
      } else if (error instanceof ValidationServiceError) {
        sendJson(response, error.status, { positive: false, code: error.code, error: error.message });
      } else {
        sendJson(response, 500, { positive: false, code: "INTERNAL_ERROR", error: "Validation failed unexpectedly." });
      }
    }
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(publicDirectory, safePath);

  // Never serve files outside public/, even if a URL contains traversal tokens.
  if (!filePath.startsWith(publicDirectory) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-cache"
  });
  createReadStream(filePath).pipe(response);
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`The Quiet Room is listening at http://localhost:${port}`);
});
