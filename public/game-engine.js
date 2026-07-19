/**
 * The finite states are deliberately explicit. The UI can use these names to
 * choose a future generated image without having to infer what just happened.
 */
export const GAME_STATES = Object.freeze({
  UNANSWERED: "unanswered",
  POSITIVE: "answered-positive",
  NEGATIVE: "answered-negative",
  WON: "final-win"
});

/**
 * Each event owns its narrative, its sentence-completion prompt, and examples
 * of answers on both sides. More examples generally produce a steadier cosine
 * comparison. imagePrompt is the future handoff to an image-generation API.
 */
export const EVENTS = Object.freeze([
  {
    id: "productive-chair",
    narrative: "Even the furniture reports directly to Payroll.",
    prompt: "I need to leave my desk to throw up from sheer stress, but my chair has a weight sensor that logs unpaid absences. To fool the system into thinking my body is still producing value, I place a ___ on the seat cushion.",
    positive: ["sandbag", "stack of books", "bag of rice", "water jug", "heavy box", "printer", "mannequin", "weights"],
    negative: ["feather", "paper", "pencil", "balloon", "tissue", "coffee cup", "paperclip", "mouse"],
    success: "The chair reports full productivity while you make a brief unscheduled escape.",
    failure: "The sensor detects negligible shareholder value. Attendance—and reality—reset.",
    imagePrompt: "Dystopian office chair with weight sensor, heavy object on cushion, empty fluorescent cubicle"
  },
  {
    id: "core-competency",
    narrative: "Quarterly planning has become a ceremonial contest of corporate symbolism.",
    prompt: "The Manager demands we place a physical item on the table that represents our \"Core Competency\" for the upcoming quarter. To outshine Henderson’s gold-plated pen and secure the title of Most Visionary, I present a ___.",
    positive: ["compass", "prism", "telescope", "seed", "blueprint", "crystal", "lightbulb", "prototype"],
    negative: ["pen", "pencil", "stapler", "paperclip", "mug", "spreadsheet", "memo", "eraser"],
    success: "The room falls silent before erupting into strategic applause. Henderson lowers his pen.",
    failure: "The Manager calls it insufficiently visionary. Henderson’s pen glints as the quarter restarts.",
    imagePrompt: "Surreal corporate boardroom, symbolic visionary object on a conference table, sterile fluorescent light"
  },
  {
    id: "loyalty-temperature",
    narrative: "The office measures devotion in degrees. Anxiety is now a compliance violation.",
    prompt: "The building’s central AI detects that my body temperature is rising due to rising panic, which indicates a low loyalty index. To instantly fool the thermal cameras into thinking I am calm and cold-blooded, I press a ___ against my neck.",
    positive: ["ice pack", "ice cube", "cold compress", "frozen bottle", "cooling pad", "bag of ice", "popsicle"],
    negative: ["heater", "hot water bottle", "scarf", "blanket", "hand warmer", "candle", "laptop"],
    success: "The loyalty index settles into an exemplary blue. The building congratulates your composure.",
    failure: "Your thermal signature spikes red. The AI schedules the entire quarter to begin again.",
    imagePrompt: "Dystopian office thermal camera view, worker cooling their neck, corporate surveillance interface"
  },
  {
    id: "synergistic-reflexes",
    narrative: "The annual retreat has reached its mandatory kinetic-collaboration module.",
    prompt: "It is the annual Team Building Retreat, and the Boss throws a high-velocity projectile at me to test my \"synergistic reflexes.\" To return fire with an appropriate amount of non-lethal, corporate-approved enthusiasm, I hurl a ___ back at him.",
    positive: ["foam ball", "stress ball", "beach ball", "tennis ball", "rubber ball", "pillow", "balloon", "sponge"],
    negative: ["brick", "rock", "knife", "hammer", "chair", "laptop", "glass bottle", "dart"],
    success: "The Boss catches it and announces a measurable increase in cross-functional momentum.",
    failure: "Human Resources classifies the impact as off-brand. The retreat starts over.",
    imagePrompt: "Absurd corporate team retreat, workers throwing soft colorful objects, deadpan cinematic framing"
  },
  {
    id: "collar-inspection",
    narrative: "Inspection approaches. Dress-code compliance is visible at the end of the corridor.",
    prompt: "My collar button has popped off just minutes before inspection. To maintain the mandatory, neck-choking crispness of my shirt, I wedge a ___ into the collar seam.",
    positive: ["safety pin", "paperclip", "binder clip", "staple", "pin", "tie clip", "collar stay", "toothpick"],
    negative: ["apple", "tennis ball", "coffee mug", "shoe", "book", "phone", "sandwich", "keyboard"],
    success: "The collar holds. Inspection passes without a single measurable sign of humanity.",
    failure: "The collar wilts below regulation angle. An alarm sounds, and the quarter begins again.",
    imagePrompt: "Extreme close-up of rigid white office collar repaired with improvised object, severe corporate inspection"
  }
]);

const WORD_PATTERN = /[a-z0-9]+/g;
// Flip this to false when event-specific examples or API embeddings are ready.
const DEBUG_CLASSIFICATION = false;

/** Convert text to lowercase tokens and discard punctuation. */
export function tokenize(text) {
  return String(text).toLowerCase().match(WORD_PATTERN) || [];
}

/**
 * Convert text into a sparse vector. Whole words carry most of the signal;
 * character trigrams add a small amount of fuzzy matching for plural forms and
 * minor typos (for example "keys" remains close to "key").
 */
export function vectorize(text) {
  const vector = new Map();
  for (const word of tokenize(text)) {
    vector.set(`w:${word}`, (vector.get(`w:${word}`) || 0) + 2);
    const padded = `^${word}$`;
    for (let index = 0; index <= padded.length - 3; index += 1) {
      const feature = `c:${padded.slice(index, index + 3)}`;
      vector.set(feature, (vector.get(feature) || 0) + 0.35);
    }
  }
  return vector;
}

/** Standard cosine similarity for two sparse vectors. */
export function cosineSimilarity(left, right) {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (const value of left.values()) leftMagnitude += value * value;
  for (const [key, value] of right) {
    rightMagnitude += value * value;
    dot += (left.get(key) || 0) * value;
  }
  if (!leftMagnitude || !rightMagnitude) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function closestExample(answer, examples) {
  const answerVector = vectorize(answer);
  return examples.reduce(
    (best, example) => {
      const score = cosineSimilarity(answerVector, vectorize(example));
      return score > best.score ? { example, score } : best;
    },
    { example: examples[0], score: 0 }
  );
}

/**
 * Classify against the closest positive and negative examples. This is a local
 * stand-in for semantic embeddings: replace this function with an async API call
 * later, while keeping its { positive, confidence } return shape unchanged.
 */
export function classifyAnswer(answer, event) {
  /*
   * TEMPORARY MECHANICS DEBUG MODE
   * ------------------------------
   * The final positive/negative example sets have not been authored yet, so we
   * bypass event-specific cosine matching for two known test commands. Keeping
   * this override inside classifyAnswer() means the state machine and UI still
   * exercise exactly the same path they will use with semantic classification.
   *
   * Remove this block when the real answer examples or embeddings API are ready.
   */
  const debugAnswer = String(answer).trim().toLowerCase();
  if (DEBUG_CLASSIFICATION) {
    if (debugAnswer === "angel") {
      return { positive: true, confidence: 1, closest: "angel" };
    }
    if (debugAnswer === "devil") {
      return { positive: false, confidence: 1, closest: "devil" };
    }

    // Unknown debug commands fail safely and reset the loop.
    return { positive: false, confidence: 0, closest: "devil" };
  }

  const positiveMatch = closestExample(answer, event.positive);
  const negativeMatch = closestExample(answer, event.negative);
  const positive = positiveMatch.score > negativeMatch.score && positiveMatch.score >= 0.22;
  const margin = Math.abs(positiveMatch.score - negativeMatch.score);
  return {
    positive,
    confidence: Math.min(1, Math.max(0.05, margin + Math.max(positiveMatch.score, negativeMatch.score))),
    closest: positive ? positiveMatch.example : negativeMatch.example
  };
}

/**
 * GameEngine is the single source of truth for progress. A wrong answer resets
 * eventIndex immediately, but leaves the NEGATIVE state visible until advance()
 * is called by the UI after the feedback delay.
 */
export class GameEngine {
  constructor(events = EVENTS) {
    this.events = events;
    this.attempt = 1;
    this.eventIndex = 0;
    this.state = GAME_STATES.UNANSWERED;
    this.lastResult = null;
  }

  get currentEvent() {
    return this.events[this.eventIndex];
  }

  answer(rawAnswer, externalResult = null) {
    if (this.state !== GAME_STATES.UNANSWERED) return null;
    // Production validation arrives from the server. The local classifier stays
    // available for tests and for the temporary angel/devil debug switch.
    const result = externalResult || classifyAnswer(rawAnswer, this.currentEvent);
    this.lastResult = { ...result, answer: rawAnswer.trim() };

    if (!result.positive) {
      this.state = GAME_STATES.NEGATIVE;
      this.eventIndex = 0;
      this.attempt += 1;
      return this.lastResult;
    }

    this.eventIndex += 1;
    this.state = this.eventIndex === this.events.length
      ? GAME_STATES.WON
      : GAME_STATES.POSITIVE;
    return this.lastResult;
  }

  advance() {
    if (this.state === GAME_STATES.POSITIVE || this.state === GAME_STATES.NEGATIVE) {
      this.state = GAME_STATES.UNANSWERED;
      this.lastResult = null;
    }
  }

  restart() {
    this.attempt = 1;
    this.eventIndex = 0;
    this.state = GAME_STATES.UNANSWERED;
    this.lastResult = null;
  }
}
