import test from "node:test";
import assert from "node:assert/strict";
import { EVENTS, GAME_STATES, GameEngine, classifyAnswer, cosineSimilarity, vectorize } from "../public/game-engine.js";

test("identical text has cosine similarity 1", () => {
  assert.equal(cosineSimilarity(vectorize("key"), vectorize("key")), 1);
});

test("local fallback still classifies a known positive example", () => {
  assert.equal(classifyAnswer("telescope", EVENTS[0]).positive, true);
});

test("local fallback still classifies a known negative example", () => {
  assert.equal(classifyAnswer("stapler", EVENTS[0]).positive, false);
});

test("positive answers advance through every event to win", () => {
  const game = new GameEngine();
  for (let index = 0; index < EVENTS.length; index += 1) {
    game.answer("test noun", { positive: true, confidence: 1, closest: "True" });
    if (game.state !== GAME_STATES.WON) game.advance();
  }
  assert.equal(game.state, GAME_STATES.WON);
  assert.equal(game.eventIndex, EVENTS.length);
});

test("negative answer increments attempt and resets to event zero", () => {
  const game = new GameEngine();
  game.answer("test noun", { positive: true, confidence: 1, closest: "True" });
  game.advance();
  game.answer("test noun", { positive: false, confidence: 1, closest: "False" });
  assert.equal(game.state, GAME_STATES.NEGATIVE);
  assert.equal(game.eventIndex, 0);
  assert.equal(game.attempt, 2);
});
