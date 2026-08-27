#!/usr/bin/env node
/**
 * Bot playtest.
 *
 * Answers three questions a screenshot cannot:
 *   1. Does a match actually reach a conclusion, or can it softlock?
 *   2. Does the power interval separate skill levels, or is every rider the same?
 *   3. Does a player who does nothing at all still get a turn and keep playing?
 *
 * All three run the game's real update path through the test hooks; nothing
 * here reaches into internals or fakes a result.
 *
 * Usage: node scripts/bot-playtest.mjs [--url URL] [--seed N] [--out FILE]
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = { url: 'http://127.0.0.1:5188', seed: 1234, out: 'artifacts/bot-playtest.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') args.url = argv[++i];
    else if (argv[i] === '--seed') args.seed = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

/** Adds the ?qa=1 opt-in that a production build needs to expose test hooks. */
function withQa(url) {
  const parsed = new URL(url);
  parsed.searchParams.set('qa', '1');
  return parsed.toString();
}

async function openGame(browser, errors, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${label}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  return { context, page };
}

/** Runs a four-bot match at one skill level and reports what happened. */
async function skillRun(page, seed, skill) {
  return page.evaluate(
    async ({ seed: s, skill: k }) => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__;
      if (!hooks) throw new Error('test hooks missing');
      hooks.seed(s);
      hooks.configure(
        [
          { controller: 'ai', animalId: 'gecko', aiSkill: k },
          { controller: 'ai', animalId: 'boar', aiSkill: k },
          { controller: 'ai', animalId: 'frog', aiSkill: k },
          { controller: 'ai', animalId: 'toucan', aiSkill: k },
        ],
        true,
      );

      const phases = [];
      let turns = 0;
      // Four fighters over a nine-round cap is 36 turns, so 44 is comfortably
      // past a legitimate match; needing all of them is the softlock evidence.
      for (let i = 0; i < 44; i += 1) {
        const before = window.__THREE_GAME_DIAGNOSTICS__?.phase;
        hooks.advanceTurns(1);
        turns += 1;
        const after = window.__THREE_GAME_DIAGNOSTICS__?.phase;
        phases.push(`${before}->${after}`);
        if (after === 'results') break;
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }

      const d = window.__THREE_GAME_DIAGNOSTICS__;
      return {
        skill: k,
        turns,
        finished: d?.phase === 'results',
        round: d?.round ?? 0,
        totalDamage: d?.score ?? 0,
        meanAccuracy: Number(
          (
            (d?.fighters ?? []).reduce((sum, f) => sum + f.accuracy * f.shots, 0) /
            Math.max(1, (d?.fighters ?? []).reduce((sum, f) => sum + f.shots, 0))
          ).toFixed(3),
        ),
        fighters: (d?.fighters ?? []).map((f) => ({
          animal: f.animal,
          health: f.health,
          alive: f.alive,
          damageDealt: f.damageDealt,
          shots: f.shots,
          accuracy: f.accuracy,
          secondsInZone: f.secondsInZone,
        })),
        phaseTransitions: phases.slice(-6),
      };
    },
    { seed, skill },
  );
}

/** A human who never touches the spacebar must still fire and pass the turn. */
async function idleHumanRun(page, seed) {
  return page.evaluate(
    async ({ seed: s }) => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__;
      if (!hooks) throw new Error('test hooks missing');
      hooks.seed(s);
      hooks.configure(
        [
          { controller: 'human', animalId: 'tortoise', aiSkill: 0.5 },
          { controller: 'ai', animalId: 'raccoon', aiSkill: 0.6 },
        ],
        true,
      );

      const waitFor = async (predicate, limit = 600) => {
        for (let i = 0; i < limit; i += 1) {
          if (predicate()) return true;
          await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        }
        return false;
      };
      // configure() publishes 'intro' synchronously; wait past it so a stale
      // 'aim' from the previous run cannot satisfy the next check instantly.
      await waitFor(() => window.__THREE_GAME_DIAGNOSTICS__?.phase === 'intro', 120);
      const reachedAim = await waitFor(
        () => window.__THREE_GAME_DIAGNOSTICS__?.phase === 'aim',
      );
      const shotsBefore = window.__THREE_GAME_DIAGNOSTICS__?.fighters[0]?.shots ?? 0;

      hooks.lockAim();
      // Deliberately tap nothing for the whole interval.
      const left = await waitFor(
        () =>
          window.__THREE_GAME_DIAGNOSTICS__?.phase !== 'aim' &&
          window.__THREE_GAME_DIAGNOSTICS__?.phase !== 'ready' &&
          window.__THREE_GAME_DIAGNOSTICS__?.phase !== 'interval',
        1400,
      );
      const shotsAfter = window.__THREE_GAME_DIAGNOSTICS__?.fighters[0]?.shots ?? 0;
      const recovered = await waitFor(
        () => (window.__THREE_GAME_DIAGNOSTICS__?.phase ?? '') !== 'flight',
        1400,
      );

      return {
        reachedAim,
        intervalEnded: left,
        firedWithoutTapping: shotsAfter > shotsBefore,
        recoveredToNextPhase: recovered,
        lastShot: window.__THREE_GAME_DIAGNOSTICS__?.lastShot ?? '',
        phase: window.__THREE_GAME_DIAGNOSTICS__?.phase ?? '',
      };
    },
    { seed },
  );
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const errors = [];
  const browser = await chromium.launch();
  const { context, page } = await openGame(browser, errors, 'bot');

  await page.goto(withQa(args.url), { waitUntil: 'load' });
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);

  const low = await skillRun(page, args.seed, 0.3);
  const high = await skillRun(page, args.seed, 0.9);
  const idle = await idleHumanRun(page, args.seed + 7);

  const frames = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0);

  const report = {
    seed: args.seed,
    url: withQa(args.url),
    frames,
    lowSkill: low,
    highSkill: high,
    idleHuman: idle,
    consoleErrors: errors,
    verdict: {
      matchesFinish: low.finished && high.finished,
      noSoftlock: low.turns < 44 && high.turns < 44,
      damageProgresses: low.totalDamage > 0 && high.totalDamage > 0,
      // The whole design rests on the interval discriminating riders: a better
      // bot must hold the target more tightly, not merely roll better dice.
      skillSeparates: high.meanAccuracy > low.meanAccuracy + 0.05,
      idleTurnStillResolves: idle.firedWithoutTapping && idle.recoveredToNextPhase,
      cleanConsole: errors.length === 0,
    },
  };

  await context.close();
  await browser.close();

  await mkdir(path.dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report, null, 2));

  const failed = Object.entries(report.verdict).filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.error('bot playtest FAILED:', failed.map(([key]) => key).join(', '));
    process.exit(1);
  }
  console.log('bot playtest PASSED ->', args.out);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
