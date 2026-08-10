/**
 * Runs one duty on this machine, against a real provider and a real thread.
 *
 * Every other way this repository exercises itself stops short of a model: the
 * unit tests mock the provider, and `main.integration.test.ts` drives the real
 * bundle against a local HTTP stub. That is the right shape for a suite — it is
 * deterministic, it is offline, and it is what CI can run on a fork's pull
 * request. It is also the reason nothing here has ever proved that a real
 * OpenAI-compatible endpoint answers the way a duty assumes, which is a
 * different claim and needs a different instrument. This is that instrument,
 * and it is deliberately not a test: it needs a network, a token and somebody
 * reading the output.
 *
 * A duty is named on the command line — `pnpm try translate` — because a duty
 * ships from its own directory beside its own `action.yml`, and that directory
 * is what a workflow names too. There is no default: guessing which decision
 * somebody meant to spend money on is not a kindness.
 *
 * What a GitHub runner does is set `INPUT_*` in the environment and spawn the
 * duty's `dist/index.js`. So does this, with two differences worth knowing:
 *
 * - **The defaults are read out of `action.yml` rather than written here.** The
 *   runner applies them from the same file, so a copy in this script would be a
 *   second set of defaults free to drift from the contract — and it would drift
 *   silently, making a local run disagree with a workflow run for a reason
 *   nobody could see.
 * - **An exported shell variable beats `.env`.** That is Node's own precedence,
 *   and it is what makes `DRY_RUN=false pnpm try translate` a one-off rather
 *   than an edit. It is equally the footgun: a `GITHUB_TOKEN` already exported
 *   in the shell is the one that will be used.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_FILE = join(ROOT, ".env");

/**
 * The `.env` key an input is read from: its own name, upper-snake-cased.
 *
 * Derived rather than tabulated, so an input added to a duty's `action.yml` is
 * configurable here the moment it exists. `.env.example` still has to name it —
 * that is a document, and `main.integration.test.ts` checks it against the same
 * contract.
 */
function envName(input) {
  return input.replace(/-/g, "_").toUpperCase();
}

/**
 * Every duty this repository ships, by the directory a workflow names.
 *
 * Read from the source tree rather than listed here, for the same reason the
 * defaults are read from `action.yml`: a second list is a list free to go
 * stale, and the failure it produces is "no such duty" about one that exists.
 */
async function duties() {
  const found = await readdir(join(ROOT, "src", "duties"), { withFileTypes: true });
  return found.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * Every input a duty's `action.yml` declares, with its default and whether it
 * is required.
 *
 * A regex rather than a YAML parser because there is no YAML dependency in this
 * repository and the shape is narrow: each input is a key at exactly two
 * spaces, and a default is either a scalar on one line or a `|` block indented
 * six. A shape this file does not understand is reported rather than guessed
 * at, because a default read wrong is worse than one not read at all.
 */
async function declaredInputs(duty) {
  const text = await readFile(join(ROOT, duty, "action.yml"), "utf8");
  const block = /\ninputs:\n([\s\S]*?)\noutputs:\n/.exec(text)?.[1];
  if (!block) throw new Error(`${duty}/action.yml: no \`inputs:\` block — has the contract moved?`);

  const inputs = [];
  const heads = [...block.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)];
  for (const [index, head] of heads.entries()) {
    const from = head.index + head[0].length;
    const to = heads[index + 1]?.index ?? block.length;
    const body = block.slice(from, to);

    inputs.push({
      name: head[1],
      required: /^ {4}required: true$/m.test(body),
      default: readDefault(body),
    });
  }
  return inputs;
}

/**
 * One input's default, or null when it has none this script can use.
 *
 * `github-token` defaults to `${{ github.token }}`, which is a runner
 * expression: there is no such token on a laptop, so it is not a default here
 * and the missing-value message below is the honest outcome.
 */
function readDefault(body) {
  const found = /^ {4}default: (.*)$/m.exec(body);
  if (found === null) return null;
  const literal = found[1];

  if (literal === "|" || literal === "|-") {
    // Only the lines after the `|`, never the whole input: a `description`
    // written as `>-` is a six-space block too, and reading it as the default
    // is a silent wrong answer rather than a parse failure — which is exactly
    // how this was found.
    const block = body.slice(found.index + found[0].length);
    const lines = [];
    for (const line of block.split("\n").slice(1)) {
      if (!/^ {6}\S/.test(line)) break;
      lines.push(line.slice(6));
    }
    return lines.join("\n");
  }
  if (literal.includes("${{")) return null;
  return literal.replace(/^["'](.*)["']$/, "$1");
}

async function main() {
  const available = await duties();
  const duty = process.argv[2];
  if (duty === undefined || !available.includes(duty)) {
    throw new Error(
      `Name a duty: ${available.map((name) => `pnpm try ${name}`).join(", ")}` +
        `${duty === undefined ? "" : ` — there is no \`${duty}\`.`}`,
    );
  }

  if (!existsSync(ENV_FILE)) {
    throw new Error(
      "No .env here. Copy .env.example to .env and fill it in — .env is git-ignored.",
    );
  }
  process.loadEnvFile(ENV_FILE);

  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error(
      "GITHUB_REPOSITORY: set it to `owner/name` in .env. Nothing local can guess it.",
    );
  }

  const env = {
    PATH: process.env.PATH,
    GITHUB_REPOSITORY: repository,
    // Named so `threadNumber`'s failure message says something true about this
    // run rather than "unknown", on the one path that reaches it.
    GITHUB_EVENT_NAME: "workflow_dispatch",
  };

  const missing = [];
  for (const input of await declaredInputs(duty)) {
    const value = process.env[envName(input.name)] ?? input.default;
    if (input.required && (value ?? "") === "") {
      missing.push(`${envName(input.name)} (input \`${input.name}\`)`);
      continue;
    }
    env[`INPUT_${input.name.toUpperCase()}`] = value ?? "";
  }
  // `github-token` is declared optional because the runner always fills it in.
  // Here nothing does, and every call to GitHub would fail one at a time.
  if ((env["INPUT_GITHUB-TOKEN"] ?? "") === "") {
    missing.push("GITHUB_TOKEN (input `github-token`) — `gh auth token` prints one");
  }
  if (missing.length > 0) {
    throw new Error(`.env is missing:\n  ${missing.join("\n  ")}`);
  }

  // Built rather than assumed, for the reason the integration suite builds:
  // otherwise this runs whatever was committed last instead of what is on disk,
  // and a local run whose result does not follow from the local source is worse
  // than no local run.
  process.stdout.write("Building…\n");
  await promisify(execFile)(process.execPath, [join(ROOT, "tools", "build.mjs")], { cwd: ROOT });

  const scratch = await mkdtemp(join(tmpdir(), "reeve-try-"));
  const outputFile = join(scratch, "outputs");
  await writeFile(outputFile, "");
  env.GITHUB_OUTPUT = outputFile;

  // `getBooleanInput` accepts `true`/`True`/`TRUE` and rejects anything that is
  // neither true nor false, so this line only has to agree with it about the
  // word — a typo becomes the duty's own error, one step later.
  const dry = (env["INPUT_DRY-RUN"] ?? "").toLowerCase() === "true";
  process.stdout.write(
    `${dry ? "Dry run" : "POSTING FOR REAL"}: ${duty} on ${repository}#${env["INPUT_NUMBER"] || "(from the event — there is none here)"}` +
      ` via ${env["INPUT_BASE-URL"]}\n\n`,
  );

  const child = spawn(process.execPath, [join(ROOT, duty, "dist", "index.js")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const code = await new Promise((resolve) => child.on("close", resolve));

  process.stdout.write(`\n--- outputs ---\n${await readFile(outputFile, "utf8")}`);
  await rm(scratch, { recursive: true, force: true });
  process.exitCode = code ?? 1;
}

await main();
