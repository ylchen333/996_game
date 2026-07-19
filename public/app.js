import { EVENTS, GAME_STATES, GameEngine } from "./game-engine.js";

const game = new GameEngine();
const form = document.querySelector("#command-form");
const input = document.querySelector("#command-input");
const output = document.querySelector("#terminal-output");
const sceneSymbol = document.querySelector("#scene-symbol");
const sceneImage = document.querySelector("#scene-image");
const sceneRender = document.querySelector("#scene-render");
const attemptLabel = document.querySelector("#attempt-label");
const progress = document.querySelector("#progress");

let generatedImageUrl;
let awaitingProceed = false;

function addLine(text, type = "system") {
  const line = document.createElement("p");
  line.className = `line ${type}`;
  line.textContent = text;
  output.append(line);
  output.scrollTop = output.scrollHeight;
  return line;
}

function renderProgress() {
  progress.replaceChildren();
  EVENTS.forEach((event, index) => {
    const marker = document.createElement("span");
    marker.className = "progress-step";
    if (index < game.eventIndex || game.state === GAME_STATES.WON) marker.classList.add("complete");
    if (index === game.eventIndex && game.state !== GAME_STATES.WON) marker.classList.add("current");
    marker.title = event.id;
    progress.append(marker);
  });
}

/** Render intentionally simple state placeholders until image APIs are wired. */
function renderState() {
  document.body.dataset.state = game.state;
  attemptLabel.textContent = `ATTEMPT ${String(game.attempt).padStart(2, "0")}`;
  input.disabled = game.state !== GAME_STATES.UNANSWERED;

  if (game.state === GAME_STATES.WON) {
    sceneSymbol.textContent = "✦";
    sceneRender.textContent = "The city opens before you. The loop is broken.";
  } else if (game.state === GAME_STATES.NEGATIVE) {
    sceneSymbol.textContent = "×";
    sceneRender.textContent = "The scene collapses back to its beginning.";
  } else {
    const event = game.currentEvent;
    sceneSymbol.textContent = game.state === GAME_STATES.POSITIVE ? "✓" : "◇";
    sceneRender.textContent = event.imagePrompt;
    if (game.state === GAME_STATES.UNANSWERED) {
      showEventBaseImage(event);
    }
  }
  renderProgress();
}

function setSceneImage(source, alt = "Generated scene") {
  sceneImage.src = source;
  sceneImage.alt = alt;
  sceneImage.hidden = false;
  sceneSymbol.hidden = true;
  sceneRender.hidden = true;
}

function showEventBaseImage(event) {
  if (generatedImageUrl) {
    URL.revokeObjectURL(generatedImageUrl);
    generatedImageUrl = undefined;
  }
  sceneImage.onerror = () => {
    sceneImage.hidden = true;
    sceneSymbol.hidden = false;
    sceneRender.hidden = false;
  };
  setSceneImage(`/api/event-image?event=${encodeURIComponent(event.id)}`, event.narrative);
}

function presentEvent() {
  addLine(game.currentEvent.narrative, "narrative");
  addLine(game.currentEvent.prompt, "prompt");
  renderState();
  input.focus();
}

function restartGame() {
  awaitingProceed = false;
  game.restart();
  output.replaceChildren();
  input.placeholder = "type one noun...";
  addLine("PROTOCOL RESTARTED", "meta");
  presentEvent();
}

/**
 * Confirmation is a separate interaction from answering. The edited result is
 * already visible at this point; Enter controls only narrative progression.
 */
function proceedFromResult() {
  awaitingProceed = false;
  input.disabled = true;
  input.placeholder = "type one noun...";

  if (game.state === GAME_STATES.WON) {
    addLine("RESOLUTION ACHIEVED. THE LOOP IS BROKEN.", "win");
    addLine("Type restart to play again.", "meta");
    input.disabled = false;
    input.focus();
    return;
  }

  const wasPositive = game.state === GAME_STATES.POSITIVE;
  addLine(wasPositive ? "ADVANCING..." : "RETURNING TO SCENE 01...", "meta");

  game.advance();
  presentEvent();
}

async function requestValidation(sentence, word) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch("/api/validate", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sentence, word })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || `Validation request failed (${response.status}).`);
      error.code = result.code || "HTTP_ERROR";
      throw error;
    }
    return result.positive === true;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("Validation timed out. Please try again.");
      timeoutError.code = "TIMEOUT";
      throw timeoutError;
    }
    if (error instanceof TypeError) {
      const networkError = new Error("The validation server could not be reached.");
      networkError.code = "NETWORK_ERROR";
      throw networkError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestEditedImage(eventId, word) {
  const response = await fetch("/api/edit-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: eventId, word })
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    const error = new Error(result.error || `Image request failed (${response.status}).`);
    error.code = result.code || "IMAGE_ERROR";
    throw error;
  }
  return response.blob();
}

function startValidationAnimation() {
  let dotCount = 1;
  const line = addLine("VALIDATING.", "meta");
  const timer = setInterval(() => {
    dotCount = dotCount % 3 + 1;
    line.textContent = `VALIDATING${".".repeat(dotCount)}`;
  }, 350);
  return () => {
    clearInterval(timer);
    line.textContent = "VALIDATION COMPLETE.";
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const answer = input.value.trim();
  input.value = "";

  if (answer.toLowerCase() === "restart") {
    restartGame();
    return;
  }

  if (awaitingProceed) {
    proceedFromResult();
    return;
  }

  if (!answer) return;

  // Capture the event before answer() moves or resets the event index.
  const answeredEvent = game.currentEvent;
  addLine(`> ${answer}`, "answer");
  input.disabled = true;
  const stopValidationAnimation = startValidationAnimation();

  let positive = false;
  // Start both independent network requests before awaiting either one. This
  // keeps Gemini validation and the potentially slow image cold start parallel.
  const validationPromise = requestValidation(answeredEvent.prompt, answer)
    .finally(stopValidationAnimation);
  const imagePromise = requestEditedImage(answeredEvent.id, answer);
  const [validationResult, imageResult] = await Promise.allSettled([validationPromise, imagePromise]);

  if (validationResult.status === "fulfilled") {
    positive = validationResult.value;
  } else {
    const error = validationResult.reason;
    console.error(error);
    const messages = {
      TIMEOUT: "VALIDATION TIMED OUT. DEFAULTING TO FALSE.",
      NETWORK_ERROR: "VALIDATION SERVER UNREACHABLE. DEFAULTING TO FALSE.",
      AUTHENTICATION_ERROR: "GEMINI AUTHENTICATION FAILED. DEFAULTING TO FALSE.",
      RATE_LIMITED: "GEMINI RATE LIMIT REACHED. DEFAULTING TO FALSE.",
      MODEL_UNAVAILABLE: "GEMINI MODEL UNAVAILABLE. DEFAULTING TO FALSE.",
      SERVICE_UNAVAILABLE: "GEMINI IS TEMPORARILY UNAVAILABLE. DEFAULTING TO FALSE."
    };
    addLine(messages[error.code] || `${error.message.toUpperCase()} DEFAULTING TO FALSE.`, "failure");
  }
  if (imageResult.status === "fulfilled") {
    if (generatedImageUrl) URL.revokeObjectURL(generatedImageUrl);
    generatedImageUrl = URL.createObjectURL(imageResult.value);
    setSceneImage(generatedImageUrl, `Scene edited to include ${answer}`);
  } else {
    console.error(imageResult.reason);
    addLine(`IMAGE EDIT FAILED: ${imageResult.reason.message}`, "failure");
  }

  const result = game.answer(answer, {
    positive,
    confidence: positive ? 1 : 0,
    closest: positive ? "True" : "False"
  });
  if (!result) return;

  addLine(`GEMINI: ${result.positive ? "TRUE" : "FALSE"}`, "meta");
  addLine(result.positive ? answeredEvent.success : answeredEvent.failure, result.positive ? "success" : "failure");
  renderState();
  addLine("PRESS ENTER TO PROCEED.", "prompt");
  awaitingProceed = true;
  input.disabled = false;
  input.placeholder = "press enter to proceed";
  input.focus();
});

addLine("THE QUIET ROOM / SENTENCE COMPLETION PROTOCOL", "meta");
addLine("Complete each action with a useful noun. One mistake returns you to the beginning.", "system");
presentEvent();
