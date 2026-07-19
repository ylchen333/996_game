import { GAME_STATES, GameEngine } from "./game-engine.js";

const KEYWORD_TOKEN = "[PlayerKeyword]";

const INTRO_TEXT = "Welcome to your internship at Synergy Corp! We are so excited to have you with us. Here at Synergy, we're not just a company \u2014 we're a family. We are thrilled to have you spend your best years with us!";

const sceneImage = document.querySelector("#scene-image");
const sceneText = document.querySelector("#scene-text");
const statusLine = document.querySelector("#status-line");
const attemptLabel = document.querySelector("#attempt-label");
const form = document.querySelector("#command-form");
const input = document.querySelector("#command-input");
const actionButton = document.querySelector("#action-button");

let game;
let generatedImageUrl;

function setStatus(text) {
  statusLine.hidden = !text;
  statusLine.textContent = text || "";
}

function showImage(source, alt) {
  sceneImage.onerror = () => {
    // A missing image falls back to text-only: the overlay stays readable.
    sceneImage.hidden = true;
  };
  sceneImage.hidden = false;
  sceneImage.src = source;
  sceneImage.alt = alt;
}

function revokeGeneratedImage() {
  if (generatedImageUrl) {
    URL.revokeObjectURL(generatedImageUrl);
    generatedImageUrl = undefined;
  }
}

function showEventImage(event, role, alt) {
  revokeGeneratedImage();
  showImage(`/api/event-image?event=${encodeURIComponent(event.eventName)}&role=${role}`, alt);
}

function render() {
  document.body.dataset.state = game.state;
  attemptLabel.textContent = `ATTEMPT ${String(game.attempt).padStart(2, "0")}`;

  const event = game.currentEvent;

  if (game.state === GAME_STATES.INTRO) {
    revokeGeneratedImage();
    showImage("/api/intro-image", "Synergy Corp orientation");
    sceneText.textContent = INTRO_TEXT;
    form.hidden = true;
    actionButton.textContent = "START GAME";
    actionButton.hidden = false;
    actionButton.focus();
  } else if (game.state === GAME_STATES.UNANSWERED) {
    showEventImage(event, "context", event.eventName);
    sceneText.textContent = event.narrative.replaceAll(KEYWORD_TOKEN, "___");
    actionButton.hidden = true;
    form.hidden = false;
    input.disabled = false;
    input.value = "";
    input.focus();
  } else if (game.state === GAME_STATES.ACTION) {
    // The submit handler already placed the edited (or fallback) action image.
    sceneText.textContent = "";
    form.hidden = true;
    actionButton.textContent = "CONTINUE";
    actionButton.hidden = false;
    actionButton.focus();
  } else if (game.state === GAME_STATES.POSITIVE || game.state === GAME_STATES.NEGATIVE) {
    const positive = game.state === GAME_STATES.POSITIVE;
    showEventImage(event, positive ? "positiveOutcome" : "negativeOutcome", event.eventName);
    sceneText.textContent = game.lastResult.outcomeText;
    form.hidden = true;
    actionButton.textContent = positive ? "NEXT" : "TRY AGAIN";
    actionButton.hidden = false;
    actionButton.focus();
  } else if (game.state === GAME_STATES.WON) {
    revokeGeneratedImage();
    sceneImage.hidden = true;
    sceneText.textContent = "CONGRATULATIONS, YOU'VE PASSED YOUR INTERNSHIP AND HAVE RECEIVED A FULL TIME OFFER!";
    form.hidden = true;
    actionButton.textContent = "PLAY AGAIN";
    actionButton.hidden = false;
    actionButton.focus();
  }
}

async function requestValidation(eventName, word) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch("/api/validate", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: eventName, word })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || `Validation request failed (${response.status}).`);
    }
    return { positive: result.positive === true, outcomeText: result.outcomeText || "" };
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Validation timed out.");
    if (error instanceof TypeError) throw new Error("The validation server could not be reached.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestEditedImage(eventName, word) {
  const response = await fetch("/api/edit-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: eventName, word })
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `Image request failed (${response.status}).`);
  }
  return response.blob();
}

function startValidationAnimation() {
  let dotCount = 1;
  setStatus("LOADING.");
  const timer = setInterval(() => {
    dotCount = dotCount % 3 + 1;
    setStatus(`LOADING${".".repeat(dotCount)}`);
  }, 350);
  return () => {
    clearInterval(timer);
    setStatus("");
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!game || game.state !== GAME_STATES.UNANSWERED) return;
  const word = input.value.trim();
  if (!word) return;

  const answeredEvent = game.currentEvent;
  input.disabled = true;
  const stopAnimation = startValidationAnimation();

  // Fire both independent requests before awaiting either one, keeping Gemini
  // validation and the potentially slow FLUX cold start parallel.
  const [validationResult, imageResult] = await Promise.allSettled([
    requestValidation(answeredEvent.eventName, word),
    requestEditedImage(answeredEvent.eventName, word)
  ]);
  stopAnimation();

  let outcome;
  if (validationResult.status === "fulfilled") {
    outcome = validationResult.value;
  } else {
    console.error(validationResult.reason);
    setStatus(`${validationResult.reason.message.toUpperCase()} DEFAULTING TO FALSE.`);
    outcome = {
      positive: false,
      outcomeText: "The validation system could not be reached. The attempt is recorded as a failure."
    };
  }

  if (imageResult.status === "fulfilled") {
    revokeGeneratedImage();
    generatedImageUrl = URL.createObjectURL(imageResult.value);
    showImage(generatedImageUrl, `The scene edited to include ${word}`);
  } else {
    console.error(imageResult.reason);
    setStatus(`IMAGE EDIT FAILED: ${imageResult.reason.message}`);
    showEventImage(answeredEvent, "action", answeredEvent.eventName);
  }

  game.answer(word, outcome);
  render();
});

actionButton.addEventListener("click", () => {
  if (game.state === GAME_STATES.INTRO) {
    game.start();
  } else if (game.state === GAME_STATES.ACTION) {
    game.showOutcome();
  } else if (game.state === GAME_STATES.POSITIVE || game.state === GAME_STATES.NEGATIVE) {
    game.advance();
  } else if (game.state === GAME_STATES.WON) {
    game.restart();
  }
  setStatus("");
  render();
});

async function init() {
  try {
    const response = await fetch("/api/events");
    const events = await response.json();
    if (!response.ok) throw new Error(events.error || `Failed to load events (${response.status}).`);
    game = new GameEngine(events);
    render();
  } catch (error) {
    console.error(error);
    sceneText.textContent = `FAILED TO LOAD STORY: ${error.message}`;
    form.hidden = true;
  }
}

init();
