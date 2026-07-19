/**
 * The finite states are deliberately explicit so the UI can pick an image and a
 * button label without inferring what just happened.
 *
 * intro           -> opening screen + Start Game button
 * unanswered      -> context image + narrative, input enabled
 * action-shown    -> FLUX-edited action image + Continue button
 * outcome-positive-> positiveOutcome image + generated text + Next button
 * outcome-negative-> negativeOutcome image + generated text + Try Again button
 * final-win       -> after the last beat's positive outcome
 */
export const GAME_STATES = Object.freeze({
  INTRO: "intro",
  UNANSWERED: "unanswered",
  ACTION: "action-shown",
  POSITIVE: "outcome-positive",
  NEGATIVE: "outcome-negative",
  WON: "final-win"
});

/**
 * GameEngine is the single source of truth for progress. Story beats come from
 * the server's /api/events endpoint (backed by local/base_imgs/events.json), so
 * any number of beats works without code changes.
 */
export class GameEngine {
  constructor(events) {
    if (!Array.isArray(events) || events.length === 0) {
      throw new Error("GameEngine requires a non-empty array of story beats.");
    }
    this.events = events;
    this.attempt = 1;
    this.eventIndex = 0;
    this.state = GAME_STATES.INTRO;
    this.lastResult = null;
  }

  get currentEvent() {
    return this.events[this.eventIndex];
  }

  /** Leave the opening screen and begin the first story beat. */
  start() {
    if (this.state === GAME_STATES.INTRO) {
      this.state = GAME_STATES.UNANSWERED;
    }
  }

  /**
   * Record the server's validation result ({ positive, outcomeText }) for the
   * submitted word. The UI shows the edited action image during this state; the
   * verdict stays hidden until showOutcome().
   */
  answer(word, result) {
    if (this.state !== GAME_STATES.UNANSWERED) return null;
    this.lastResult = { ...result, answer: String(word).trim() };
    this.state = GAME_STATES.ACTION;
    return this.lastResult;
  }

  /** Reveal the positive or negative outcome recorded by answer(). */
  showOutcome() {
    if (this.state !== GAME_STATES.ACTION) return;
    this.state = this.lastResult.positive ? GAME_STATES.POSITIVE : GAME_STATES.NEGATIVE;
  }

  /**
   * A positive outcome advances to the next beat (or the win state after the
   * last one). A negative outcome retries the same beat.
   */
  advance() {
    if (this.state === GAME_STATES.POSITIVE) {
      this.eventIndex += 1;
      this.state = this.eventIndex === this.events.length ? GAME_STATES.WON : GAME_STATES.UNANSWERED;
      this.lastResult = null;
    } else if (this.state === GAME_STATES.NEGATIVE) {
      this.attempt += 1;
      this.state = GAME_STATES.UNANSWERED;
      this.lastResult = null;
    }
  }

  /** Return to the opening screen with all progress cleared. */
  restart() {
    this.attempt = 1;
    this.eventIndex = 0;
    this.state = GAME_STATES.INTRO;
    this.lastResult = null;
  }
}
