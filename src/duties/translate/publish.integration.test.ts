import { getOctokit } from "@actions/github";
import { describe, expect, it } from "vitest";

import { createReply, createThread, listReplies, type GitHubApi } from "../../core/forge.js";
import type { Language } from "../../core/languages.js";
import type { Completion, Provider } from "../../core/provider.js";
import { publish } from "../../core/publish.js";

import { translate } from "./draft.js";
import { judge } from "./judge.js";
import { marker, publication, translationFingerprint, type Translated } from "./publish.js";

/**
 * The body a real run would leave, written through a real client port.
 *
 * The unit tests build a `Translated` by hand, which proves the rendering and
 * proves nothing about the four things that only show up end to end: that what
 * `translate` and `judge` hand over survives being put in a `<details>` block
 * with its code intact, that the core's publish stage and this duty's marker
 * agree on where the block starts, that a second run finds and replaces the
 * block the first one wrote rather than nesting another inside it, and that the
 * author's half comes back out of a written body byte-for-byte. So the endpoint
 * is scripted for the same reason as everywhere else, GitHub is an in-memory
 * thread that actually keeps what it is given, and everything between them is
 * the real thing.
 */

const vietnamese: Language = { code: "vi", label: "Tiếng Việt", scripts: ["Latin"] };
const english: Language = { code: "en", label: "English", scripts: ["Latin"] };
const chinese: Language = { code: "zh", label: "中文", scripts: ["Han"] };

function scripted(answers: Record<string, string>): Provider {
  return {
    complete(model: string): Promise<Completion> {
      const answer = answers[model];
      return Promise.resolve<Completion>(
        answer === undefined
          ? { ok: false, model, reason: "no answer scripted", kind: "protocol" }
          : { ok: true, model, content: answer, finishReason: "stop" },
      );
    },
  };
}

const SOURCE = [
  "Sau khi nâng cấp thì trình đóng gói không còn phân giải đúng entry point nữa.",
  "",
  "```sh",
  "pnpm build --filter @ecoma-io/reeve",
  "```",
  "",
  "Chi tiết ở #42, cc @johnitvn.",
].join("\n");

const ENGLISH = [
  "After the upgrade the bundler no longer resolves the entry point correctly.",
  "",
  "```sh",
  "pnpm build --filter @ecoma-io/reeve",
  "```",
  "",
  "Details in #42, cc @johnitvn.",
].join("\n");

const CHINESE = [
  "升级后打包器不再正确解析入口点。",
  "",
  "```sh",
  "pnpm build --filter @ecoma-io/reeve",
  "```",
  "",
  "详见 #42，抄送 @johnitvn。",
].join("\n");

/**
 * A thread that keeps its body and its replies, so a second run reads what the
 * first wrote — for a comment exactly as for the body.
 */
function threadWith(
  body: string,
  comments: { id: number; body: string }[] = [],
): GitHubApi & { body(): string; reply(id: number): string } {
  let stored = body;
  const replies = new Map(comments.map((comment) => [comment.id, comment.body]));

  return {
    body: () => stored,
    reply: (id) => replies.get(id) ?? "",
    rest: {
      issues: {
        get: () => Promise.resolve({ data: { body: stored } }),
        update: ({ body: next }) => {
          stored = next;
          return Promise.resolve(undefined);
        },
        listComments: () =>
          Promise.resolve({
            data: [...replies].map(([id, text]) => ({ id, body: text })),
          }),
        updateComment: ({ comment_id: id, body: next }) => {
          replies.set(id, next);
          return Promise.resolve(undefined);
        },
        getComment: ({ comment_id: id }) =>
          Promise.resolve({ data: { body: replies.get(id) ?? "" } }),
      },
    },
  };
}

const AT = { owner: "ecoma-io", repo: "reeve", number: 42 };

/** One target language taken all the way through translation and judging. */
async function best(to: Language, answers: Record<string, string>) {
  const models = Object.keys(answers);
  const drafted = await translate({
    provider: scripted(answers),
    models,
    source: SOURCE,
    from: vietnamese,
    to,
    languages: [vietnamese, english, chinese],
    drafts: models.length,
  });
  const verdict = await judge({
    provider: scripted({}),
    judges: [],
    source: SOURCE,
    to,
    attempts: drafted.attempts,
  });
  return verdict.winner;
}

/** What a run would publish, built from real translations rather than by hand. */
async function run(targets: [Language, Record<string, string>][]): Promise<Translated> {
  const posted = [];
  const skipped = [];
  for (const [to, answers] of targets) {
    const winner = await best(to, answers);
    if (winner === null) skipped.push(to);
    else posted.push({ to, text: winner.text, model: winner.model });
  }
  return {
    from: vietnamese,
    posted,
    skipped,
    truncated: false,
    attribution: "none",
    // Off by default here, so every case below reads the block a translation
    // renders rather than the chrome around it. The one case that is about the
    // line turns it on for itself — and a reply never gets it at all, which is
    // `translateReplies`'s decision rather than this stage's.
    branding: false,
    fingerprint: translationFingerprint(
      SOURCE,
      targets.map(([to]) => to),
    ),
  };
}

/** The whole stage as a run performs it: this duty's block, through the core. */
function publishing(thread: GitHubApi, translated: Translated) {
  return publish(createThread(thread, AT), marker, publication(translated));
}

describe("publishing what a real run produced", () => {
  it("appends the translation with its code block intact", async () => {
    const thread = threadWith(SOURCE);

    const outcome = await publishing(thread, await run([[english, { a: ENGLISH }]]));

    expect(outcome.action).toBe("published");
    // The blank line after `</summary>` is what makes GitHub render the block
    // as code rather than as a row of backticks inside raw HTML — the section's
    // own boundary note sits between the summary and the translation.
    expect(thread.body()).toContain("</summary>\n\n> ");
    expect(thread.body()).toContain("counts.\n\nAfter the upgrade");
    expect(thread.body()).toContain("```sh\npnpm build --filter @ecoma-io/reeve\n```");
    // And what reaches the reader is the sanitized text, so the references in
    // it cannot notify anyone a second time.
    expect(thread.body()).toContain("#<!---->42");
    expect(thread.body()).toContain("@<!---->johnitvn");
  });

  it("carries the branding line through a real write, with the author's half intact", async () => {
    // The `<img>` is the one piece of raw HTML this duty writes on purpose, so
    // it is worth seeing it survive the assembler and come back out of a
    // written body — and worth seeing that the marker still splits the body in
    // the same place with it there.
    const thread = threadWith(SOURCE);

    const outcome = await publishing(thread, {
      ...(await run([[english, { a: ENGLISH }]])),
      branding: true,
    });

    expect(outcome.action).toBe("published");
    expect(thread.body()).toContain(
      '<img src="https://raw.githubusercontent.com/ecoma-io/reeve/v0.',
    );
    expect(thread.body()).toContain("— autonomous repository operations</sub>");
    expect(marker.split(thread.body()).official).toBe(SOURCE);
  });

  it("leaves the author's own text untouched, references and all", async () => {
    // The whole reason this appends rather than rewrites: everything GitHub
    // reads out of a body has to keep working. The author's `#42` still links
    // and their `@johnitvn` still notifies — it is only the machine's copy of
    // them that is defanged.
    const thread = threadWith(SOURCE);

    await publishing(thread, await run([[english, { a: ENGLISH }]]));

    expect(thread.body().startsWith(SOURCE)).toBe(true);
    expect(marker.split(thread.body()).official).toBe(SOURCE);
  });

  it("replaces its own block on a second run instead of nesting another", async () => {
    const thread = threadWith(SOURCE);

    await publishing(thread, await run([[english, { a: ENGLISH }]]));
    const again = await publishing(
      thread,
      await run([[english, { a: ENGLISH.replace("no longer resolves", "stops resolving") }]]),
    );

    expect(again).toEqual({ action: "published", mismatched: false });
    expect(thread.body().split("reeve:translate")).toHaveLength(2);
    expect(marker.split(thread.body()).official).toBe(SOURCE);
  });

  it("changes nothing when the thread and the models both said the same thing again", async () => {
    const thread = threadWith(SOURCE);

    const first = await publishing(thread, await run([[english, { a: ENGLISH }]]));
    const written = thread.body();
    const second = await publishing(thread, await run([[english, { a: ENGLISH }]]));

    expect(first).toEqual({ action: "published", mismatched: false });
    expect(second).toEqual({ action: "unchanged" });
    expect(thread.body()).toBe(written);
  });

  it("publishes a fingerprint the next run reads back as its own", async () => {
    // The loop guard end to end: writing the body fires the `edited` event a
    // Reeve workflow listens for, and the run that starts has to recognise its
    // own output before it spends anything.
    const thread = threadWith(SOURCE);

    await publishing(thread, await run([[english, { a: ENGLISH }]]));

    const seen = marker.split(thread.body());
    expect(seen.fingerprint).toBe(translationFingerprint(seen.official, [english]));
  });

  it("collapses two languages and names the one nothing translated", async () => {
    const thread = threadWith(SOURCE);

    await publishing(
      thread,
      await run([
        [english, { a: ENGLISH }],
        [chinese, { a: CHINESE }],
        // A model that answered in the source language is refused by `score`,
        // so this language reaches the body as skipped rather than as a
        // translation that is not one.
        [{ code: "ja", label: "日本語", scripts: ["Hiragana"] }, { a: SOURCE }],
      ]),
    );

    expect(thread.body()).not.toContain("<details open>");
    expect(thread.body()).toContain("<b>English</b>");
    expect(thread.body()).toContain("<b>中文</b>");
    expect(thread.body()).toContain("Not translated this run: 日本語.");
  });

  it("leaves the thread alone when nothing this run translated", async () => {
    const thread = threadWith(SOURCE);

    const outcome = await publishing(thread, await run([[english, { a: SOURCE }]]));

    expect(outcome.action).toBe("none");
    expect(thread.body()).toBe(SOURCE);
  });

  it("accepts the client @actions/github builds", () => {
    // The port is declared structurally, so nothing but this assignment proves
    // the real client fits it — and a mismatch here is a compile error rather
    // than a run that fails in somebody's workflow. `getOctokit` builds a
    // client without contacting anything.
    const real: GitHubApi = getOctokit("not-a-real-token");

    expect(real.rest.issues.update).toBeTypeOf("function");
    expect(real.rest.issues.updateComment).toBeTypeOf("function");
    expect(real.rest.issues.listComments).toBeTypeOf("function");
    expect(real.rest.issues.getComment).toBeTypeOf("function");
  });
});

describe("publishing into a reply", () => {
  it("appends to the comment and leaves the thread body alone", async () => {
    const thread = threadWith(SOURCE, [{ id: 991, body: SOURCE }]);
    const [reply] = (await listReplies(thread, AT)).replies;

    const outcome = await publish(
      createReply(thread, AT, reply ?? { id: 0, body: "", login: "", isBot: false }),
      marker,
      publication(await run([[english, { a: ENGLISH }]])),
    );

    expect(outcome.action).toBe("published");
    expect(thread.reply(991)).toContain("After the upgrade");
    expect(thread.reply(991)).toContain("```sh\npnpm build --filter @ecoma-io/reeve\n```");
    // The failure worth pinning: a reply's translation landing in the body.
    expect(thread.body()).toBe(SOURCE);
  });

  it("keeps the replier's own words as the official half", async () => {
    const thread = threadWith(SOURCE, [{ id: 991, body: SOURCE }]);
    const [reply] = (await listReplies(thread, AT)).replies;

    await publish(
      createReply(thread, AT, reply ?? { id: 0, body: "", login: "", isBot: false }),
      marker,
      publication(await run([[english, { a: ENGLISH }]])),
    );

    expect(marker.split(thread.reply(991)).official).toBe(SOURCE);
  });

  it("gives each reply its own fingerprint, so one edit does not re-spend the rest", async () => {
    // The property a hundred-reply backfill rests on. Two replies with
    // different text get different fingerprints, so editing one leaves the
    // other's block recognised and free.
    const thread = threadWith(SOURCE, [
      { id: 991, body: SOURCE },
      { id: 992, body: `${SOURCE} Tôi cũng gặp lỗi này.` },
    ]);
    const { replies } = await listReplies(thread, AT);

    for (const reply of replies) {
      const translated = await run([[english, { a: ENGLISH }]]);
      await publish(
        createReply(thread, AT, reply),
        marker,
        publication({
          ...translated,
          fingerprint: translationFingerprint(marker.split(reply.body).official, [english]),
        }),
      );
    }

    expect(marker.split(thread.reply(991)).fingerprint).not.toBe(
      marker.split(thread.reply(992)).fingerprint,
    );
    for (const id of [991, 992]) {
      const seen = marker.split(thread.reply(id));
      expect(seen.fingerprint).toBe(translationFingerprint(seen.official, [english]));
    }
  });
});
