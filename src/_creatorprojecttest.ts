import assert from "node:assert/strict";
import { readCreatorProject, creatorProjectToolNames, type CreatorRepository } from "./creator-projects.js";

const repo = (name: string): CreatorRepository => ({ name, description: "Fixture project", language: "TypeScript", archived: false });
function github(repos: CreatorRepository[], readme: string | number = "# Fixture\nVerified features") {
  const calls: string[] = [];
  const request = (async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url);
    assert(path.startsWith("https://api.github.com/"));
    assert.equal(options?.redirect, "error");
    calls.push(path);
    if (path.includes("/users/")) {
      const page = Number(new URL(path).searchParams.get("page"));
      return Response.json(repos.slice((page - 1) * 100, page * 100));
    }
    assert.equal(options?.headers && (options.headers as Record<string, string>).Accept, "application/vnd.github.raw+json");
    return typeof readme === "number" ? new Response("Unavailable", { status: readme }) : new Response(readme);
  }) as typeof fetch;
  return { request, calls };
}

const success = github([repo("Gita.AI")]);
const gita = await readCreatorProject("Gita AI", undefined, success.request);
assert.equal(gita.status, "ready");
assert.equal(gita.url, "https://github.com/thedeepakreddy/Gita.AI");
assert(gita.readme?.includes("Verified features"));

const ambiguous = github([repo("Aira-web"), repo("Aira-desktop")]);
const choices = await readCreatorProject("Aira", undefined, ambiguous.request);
assert.equal(choices.status, "ambiguous");
assert.equal(choices.candidates?.length, 2);
assert.equal(ambiguous.calls.length, 1); // Do not read an arbitrary README.
assert.equal((await readCreatorProject("Aira", "Aira-desktop", ambiguous.request)).repository, "Aira-desktop");
assert.equal((await readCreatorProject("Aira", "../../other-owner/repo", ambiguous.request)).status, "unavailable");

const missing = github([repo("unrelated")]);
assert.equal((await readCreatorProject("Cosmos", undefined, missing.request)).status, "unavailable");
assert.equal(missing.calls.length, 1);
assert.equal((await readCreatorProject("unknown", undefined, missing.request)).status, "unavailable");
assert.equal(missing.calls.length, 1);

const noReadme = github([repo("HelpIn")], 404);
const unavailable = await readCreatorProject("HelpIn", undefined, noReadme.request);
assert.equal(unavailable.status, "unavailable");
assert.equal(unavailable.url, "https://github.com/thedeepakreddy/HelpIn");
assert.equal(unavailable.readme, undefined);

const paged = github([...Array.from({ length: 100 }, (_, n) => repo(`other-${n}`)), repo("AI-Data-Science-Studio")], "x".repeat(17_000));
const studio = await readCreatorProject("AI Data Science Studio", undefined, paged.request);
assert.equal(studio.status, "ready");
assert.equal(paged.calls.length, 3);
assert.equal(studio.readme?.length, 16_000);
assert.equal(studio.readmeTruncated, true);

for (const status of [403, 429, 500]) {
  const result = await readCreatorProject("Cosmos", undefined, (async () => new Response("error", { status })) as typeof fetch);
  assert.equal(result.status, "unavailable");
  assert(result.message?.includes(String(status)));
}
assert(creatorProjectToolNames("Tell me about risk intelligence").includes("read_creator_project"));
assert.deepEqual(creatorProjectToolNames("hello"), []);
console.log("Creator project lookup checks passed (README, ambiguity, missing/private, pagination, truncation and API failures).");
