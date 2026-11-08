import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/ci/docs-only.sh");

async function classify(paths) {
  const child = Bun.spawn(["bash", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(paths.join("\n"));
  child.stdin.end();
  const out = (await new Response(child.stdout).text()).trim();
  expect(await child.exited).toBe(0);
  return out;
}

describe("CI docs-only change classifier", () => {
  it.each([
    [["README.md"]],
    [["README.md", "ROADMAP.md", "CHANGELOG.md"]],
    [["docs/ARCHITECTURE.md"]],
    [["specs/017-model-import-testing/contracts/import.json"]],
    [["cli/README.md", "Docs/Guide.MD"]],
  ])("treats %j as docs only", async (paths) => {
    expect(await classify(paths)).toBe("docs_only=true");
  });

  it.each([
    [["README.md", "src/app/page.js"]],
    [["open-sse/AGENTS.md"]],
    [["src/lib/notes.md"]],
    [["public/help.md"]],
    [["Dockerfile.bun"]],
    [["package.json"]],
    [[".github/workflows/verify.yml"]],
    [["tests/unit/example.test.js"]],
    [[]],
  ])("requires the full pipeline for %j", async (paths) => {
    expect(await classify(paths)).toBe("docs_only=false");
  });

  it("does not trust a code deletion hidden behind a docs addition", async () => {
    // The workflow passes --no-renames, so a moved file reports both sides.
    expect(await classify(["src/old.js", "docs/old.md"])).toBe("docs_only=false");
  });
});
