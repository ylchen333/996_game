import test from "node:test";
import assert from "node:assert/strict";
import { GAME_STATES, GameEngine } from "../public/game-engine.js";

const EVENTS = [
  { eventName: "Throw", narrative: "I hurl a [PlayerKeyword] back at him." },
  { eventName: "Throw2", narrative: "I hurl a [PlayerKeyword] back at him again." }
];

test("engine rejects an empty event list", () => {
  assert.throws(() => new GameEngine([]));
});

test("answering moves to the action state and stores the result", () => {
  const game = new GameEngine(EVENTS);
  const result = game.answer("foam ball", { positive: true, outcomeText: "Well done." });
  assert.equal(game.state, GAME_STATES.ACTION);
  assert.equal(result.answer, "foam ball");
  assert.equal(result.outcomeText, "Well done.");
});

test("answering is ignored outside the unanswered state", () => {
  const game = new GameEngine(EVENTS);
  game.answer("foam ball", { positive: true, outcomeText: "ok" });
  assert.equal(game.answer("brick", { positive: false, outcomeText: "no" }), null);
});

test("showOutcome reveals the positive outcome", () => {
  const game = new GameEngine(EVENTS);
  game.answer("foam ball", { positive: true, outcomeText: "ok" });
  game.showOutcome();
  assert.equal(game.state, GAME_STATES.POSITIVE);
});

test("showOutcome reveals the negative outcome", () => {
  const game = new GameEngine(EVENTS);
  game.answer("brick", { positive: false, outcomeText: "no" });
  game.showOutcome();
  assert.equal(game.state, GAME_STATES.NEGATIVE);
});

test("a positive outcome advances to the next beat", () => {
  const game = new GameEngine(EVENTS);
  game.answer("foam ball", { positive: true, outcomeText: "ok" });
  game.showOutcome();
  game.advance();
  assert.equal(game.state, GAME_STATES.UNANSWERED);
  assert.equal(game.eventIndex, 1);
  assert.equal(game.attempt, 1);
});

test("a negative outcome retries the same beat and increments attempt", () => {
  const game = new GameEngine(EVENTS);
  game.answer("brick", { positive: false, outcomeText: "no" });
  game.showOutcome();
  game.advance();
  assert.equal(game.state, GAME_STATES.UNANSWERED);
  assert.equal(game.eventIndex, 0);
  assert.equal(game.attempt, 2);
});

test("winning requires a positive outcome on every beat", () => {
  const game = new GameEngine(EVENTS);
  for (let index = 0; index < EVENTS.length; index += 1) {
    game.answer("foam ball", { positive: true, outcomeText: "ok" });
    game.showOutcome();
    game.advance();
  }
  assert.equal(game.state, GAME_STATES.WON);
  assert.equal(game.eventIndex, EVENTS.length);
});

test("restart returns to the first beat", () => {
  const game = new GameEngine(EVENTS);
  game.answer("foam ball", { positive: true, outcomeText: "ok" });
  game.showOutcome();
  game.advance();
  game.restart();
  assert.equal(game.state, GAME_STATES.UNANSWERED);
  assert.equal(game.eventIndex, 0);
  assert.equal(game.attempt, 1);
});
