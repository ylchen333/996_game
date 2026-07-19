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
const eventManifestPath = join(baseImagesDirectory, "events.json");
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

const KEYWORD_TOKEN = "[PlayerKeyword]";
const IMAGE_ROLES = ["context", "action", "positiveOutcome", "negativeOutcome"];
const REQUIRED_TEXT_FIELDS = [
  "eventName",
  "narrative",
  "validationTestPrompt",
  "successPrompt",
  "negativePrompt",
  "imageEditPrompt"
];

const VALIDATION_FRAMING = `You are a true/false validation algorithm for a game about training to become the perfect employee. Apply the validation test below to the player's input word. Respond with exactly one word: "True" or "False".`;

const OUTCOME_FRAMING = "Respond with one or two short sentences of in-game narration addressed to the player. Do not use markdown, quotation marks, or preamble.";

// Shown when Gemini cannot produce outcome text, so the game never stalls.
const FALLBACK_OUTCOMES = {
  positive: "The Manager nods once. Value has been produced. You may proceed.",
  negative: "The Manager stares in silence. Your choice has been noted in your permanent file."
};

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

class ValidationServiceError extends Error {
  constructor(message, status = 502, code = "GEMINI_ERROR") {
    super(message);
    this.name = "ValidationServiceError";
    this.status = status;
    this.code = code;
  }
}

/** Read and validate the story manifest. Any number of beats is allowed. */
function readEventManifest() {
  if (!existsSync(eventManifestPath)) {
    throw new ValidationServiceError("local/base_imgs/events.json was not found.", 500, "MISSING_MANIFEST");
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(eventManifestPath, "utf8"));
  } catch (error) {
    throw new ValidationServiceError(`events.json is not valid JSON: ${error.message}`, 500, "INVALID_MANIFEST");
  }
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new ValidationServiceError("events.json must contain a non-empty array of story beats.", 500, "INVALID_MANIFEST");
  }
  manifest.forEach((entry, index) => {
    for (const field of REQUIRED_TEXT_FIELDS) {
      if (typeof entry?.[field] !== "string" || !entry[field].trim()) {
        throw new ValidationServiceError(`events.json entry ${index} is missing the '${field}' field.`, 500, "INVALID_MANIFEST");
      }
    }
    for (const role of IMAGE_ROLES) {
      if (typeof entry?.images?.[role] !== "string" || !entry.images[role].trim()) {
        throw new ValidationServiceError(`events.json entry '${entry.eventName}' is missing the images.${role} filename.`, 500, "INVALID_MANIFEST");
      }
    }
  });
  return manifest;
}

function getEvent(eventName) {
  const entry = readEventManifest().find((item) => item.eventName === eventName);
  if (!entry) {
    throw new ValidationServiceError(`No story beat named '${eventName}' exists in events.json.`, 404, "EVENT_NOT_FOUND");
  }
  return entry;
}

function substituteKeyword(text, word) {
  return text.replaceAll(KEYWORD_TOKEN, word);
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

function geminiHttpError(status) {
  if (status === 400) return new ValidationServiceError("Gemini rejected the validation request.", 502, "BAD_GEMINI_REQUEST");
  if (status === 401 || status === 403) return new ValidationServiceError("Gemini authentication failed. Check the API key.", 503, "AUTHENTICATION_ERROR");
  if (status === 404) return new ValidationServiceError("The configured Gemini model is unavailable.", 503, "MODEL_UNAVAILABLE");
  if (status === 429) return new ValidationServiceError("Gemini rate limit reached. Try again shortly.", 429, "RATE_LIMITED");
  if (status >= 500) return new ValidationServiceError("Gemini is temporarily unavailable.", 503, "SERVICE_UNAVAILABLE");
  return new ValidationServiceError("Gemini validation failed.");
}

/** Single Gemini text call; returns the joined non-thought answer text or undefined. */
async function requestGemini(promptText, { temperature, maxOutputTokens }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Gemini request failed: GEMINI_API_KEY is not configured.");
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
          contents: [{ role: "user", parts: [{ text: promptText }] }],
          generationConfig: {
            temperature,
            // A generous cap prevents reasoning tokens from truncating the answer.
            maxOutputTokens,
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
    console.error(`Gemini request failed (${response.status}): ${errorText}`);
    throw geminiHttpError(response.status);
  }

  const payload = await response.json();
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  // A Gemini response can contain multiple parts. Thought-summary parts must not
  // be interpreted as the final answer.
  const answer = parts
    .filter((part) => part?.text && part.thought !== true)
    .map((part) => part.text)
    .join("")
    .trim() || undefined;

  if (answer === undefined) {
    console.error("Gemini response contained no answer text:", JSON.stringify({
      finishReason: payload?.candidates?.[0]?.finishReason,
      promptFeedback: payload?.promptFeedback,
      usageMetadata: payload?.usageMetadata,
      parts
    }));
  }
  return answer;
}

/**
 * Judge the player's word against the beat's validation test. The test text has
 * already had [PlayerKeyword] substituted. Anything other than exactly "True"
 * fails closed as false.
 */
async function validateWithGemini(validationTest, word) {
  const answer = await requestGemini(
    `${VALIDATION_FRAMING}\n\nValidation test: ${validationTest}\nInput word: ${word}\n\nReturn only True or False.`,
    { temperature: 0, maxOutputTokens: 512 }
  );
  console.log("Gemini validation returned:", JSON.stringify(answer));
  if (answer === "True") return true;
  if (answer === "False") return false;
  console.error("Gemini returned an invalid validation answer:", JSON.stringify(answer));
  return false;
}

/** Generate the success or failure narration from the beat's outcome prompt. */
async function generateOutcomeText(outcomePrompt) {
  const answer = await requestGemini(
    `${outcomePrompt}\n\n${OUTCOME_FRAMING}`,
    { temperature: 0.8, maxOutputTokens: 1024 }
  );
  if (!answer) {
    throw new ValidationServiceError("Gemini returned no outcome text.", 502, "EMPTY_OUTCOME");
  }
  return answer;
}

/**
 * Send the beat's action image and its edit prompt (with the player's word
 * substituted) to the FLUX edit service. The returned PNG stays in memory only
 * long enough to stream it back to the current browser.
 */
async function editEventImage(eventName, word) {
  const event = getEvent(eventName);
  const editImagePath = resolveBaseImage(event.images.action);
  const baseUrl = (process.env.IMAGE_EDIT_BASE_URL || "https://steph--flux2-klein-9b-web-fluxmodel-web.modal.run").replace(/\/$/, "");
  const timeoutMs = Number(process.env.IMAGE_EDIT_TIMEOUT_MS) || 300_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const form = new FormData();
  const mimeType = mimeTypes[extname(editImagePath)] || "application/octet-stream";
  form.append("image", new Blob([readFileSync(editImagePath)], { type: mimeType }), basename(editImagePath));
  form.append("prompt", substituteKeyword(event.imageEditPrompt, word));
  form.append("num_inference_steps", "4");
  form.append("guidance_scale", "1.0");

  // Modal cold starts can answer the first request with a transient 5xx while
  // the GPU container boots. The API is idempotent and documented as safe to
  // retry on 5xx/timeout, so retry those; only 4xx responses are final.
  const maxAttempts = 3;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let apiResponse;
      try {
        apiResponse = await fetch(`${baseUrl}/generate`, {
          method: "POST",
          signal: controller.signal,
          body: form
        });
      } catch (error) {
        if (error.name === "AbortError") {
          throw new ValidationServiceError(`Image generation timed out after ${timeoutMs}ms.`, 504, "IMAGE_TIMEOUT");
        }
        if (attempt === maxAttempts) {
          throw new ValidationServiceError("Could not connect to the image edit service.", 503, "IMAGE_NETWORK_ERROR");
        }
        console.warn(`Image edit connection failed (attempt ${attempt}/${maxAttempts}), retrying:`, error.message);
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
        continue;
      }

      if (apiResponse.ok) {
        const contentType = apiResponse.headers.get("content-type") || "";
        if (!contentType.includes("image/png")) {
          throw new ValidationServiceError("The image edit service returned a non-PNG response.", 502, "INVALID_IMAGE_RESPONSE");
        }
        return Buffer.from(await apiResponse.arrayBuffer());
      }

      const detail = (await apiResponse.text()).slice(0, 500);
      console.error(`Image edit request failed (${apiResponse.status}, attempt ${attempt}/${maxAttempts}): ${detail}`);
      if (apiResponse.status >= 500 && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
        continue;
      }
      const status = apiResponse.status === 422 ? 502 : 503;
      throw new ValidationServiceError("The image edit service rejected the request.", status, "IMAGE_EDIT_FAILED");
    }
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

  if (request.method === "GET" && pathname === "/api/intro-image") {
    try {
      const filePath = resolveBaseImage("0.png");
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

  // Client-safe story data only: prompts for Gemini and FLUX stay server-side.
  if (request.method === "GET" && pathname === "/api/events") {
    try {
      const events = readEventManifest().map(({ eventName, narrative }) => ({ eventName, narrative }));
      sendJson(response, 200, events);
    } catch (error) {
      const status = error instanceof ValidationServiceError ? error.status : 500;
      sendJson(response, status, { code: error.code || "MANIFEST_ERROR", error: error.message });
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/event-image") {
    try {
      const url = new URL(request.url, "http://localhost");
      const role = url.searchParams.get("role") || "context";
      if (!IMAGE_ROLES.includes(role)) {
        sendJson(response, 400, { code: "INVALID_IMAGE_ROLE", error: `role must be one of: ${IMAGE_ROLES.join(", ")}.` });
        return;
      }
      const event = getEvent(url.searchParams.get("event"));
      const filePath = resolveBaseImage(event.images[role]);
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
      const { event: eventName, word } = await readJson(request);
      if (typeof eventName !== "string" || typeof word !== "string" || !word.trim() || word.length > 40) {
        sendJson(response, 400, { code: "INVALID_IMAGE_INPUT", error: "An event and input word are required." });
        return;
      }
      const png = await editEventImage(eventName, word.trim());
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
      const { event: eventName, word } = await readJson(request);
      if (typeof eventName !== "string" || typeof word !== "string" || !word.trim() || word.length > 40) {
        sendJson(response, 400, { positive: false, error: "An event and input word are required." });
        return;
      }
      const event = getEvent(eventName);
      const trimmedWord = word.trim();
      const positive = await validateWithGemini(substituteKeyword(event.validationTestPrompt, trimmedWord), trimmedWord);

      let outcomeText;
      try {
        const outcomePrompt = substituteKeyword(positive ? event.successPrompt : event.negativePrompt, trimmedWord);
        outcomeText = await generateOutcomeText(outcomePrompt);
      } catch (error) {
        console.error("Outcome text generation failed, using fallback:", error);
        outcomeText = positive ? FALLBACK_OUTCOMES.positive : FALLBACK_OUTCOMES.negative;
      }

      sendJson(response, 200, { positive, outcomeText });
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
  console.log(`996 is listening at http://localhost:${port}`);
});
