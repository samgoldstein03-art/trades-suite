import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script, createContext } from "node:vm";
import { buildBrowserDemo } from "../scripts/build-browser-demo.js";

test("standalone draft links open the actual owner-review documents without a network request", () => {
  const directory = mkdtempSync(join(tmpdir(), "tradesuite-pilot-preview-"));
  try {
    const html = readFileSync(buildBrowserDemo(join(directory, "preview.html")), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const documents = JSON.parse(script.match(/const browserLegalDocuments = ([\s\S]*?);\nconst createBrowserQuotes/)[1]);
    const frontend = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").split('document.addEventListener("click"')[0];
    assert.ok(html.includes("connect-src 'none'"));
    assert.doesNotMatch(html, /href="\/(?:terms|privacy)"/);
    for (const kind of ["terms", "privacy"]) {
      const main = { innerHTML: "" };
      let customerView;
      const document = {
        body: { classList: { toggle(name, value) { customerView = value; } } },
        querySelector: (selector) => selector === "#main" ? main : null,
      };
      const context = createContext({ document, location: { hash: `#${kind}` }, browserLegalDocuments: documents });
      new Script(`${frontend}\nstate.config.browser_demo = true; render();`).runInContext(context);
      assert.equal(customerView, true, "drafts do not expose the admin shell");
      assert.match(document.title, /draft \| Tradesuite$/);
      assert.match(main.innerHTML, /Draft\. Owner review required\./);
      assert.match(main.innerHTML, /No effective date has been set/);
      assert.match(main.innerHTML, /href="#terms"/);
      assert.match(main.innerHTML, /href="#privacy"/);
      assert.match(main.innerHTML, /href="#dashboard"/);
      assert.doesNotMatch(main.innerHTML, /<main\b/, "the public document cannot nest a main landmark");
      assert.doesNotMatch(main.innerHTML, /<form\b/, "a review draft does not ask customers to accept it");
    }
  } finally {
    const preview = join(directory, "preview.html");
    if (existsSync(preview)) unlinkSync(preview);
    rmdirSync(directory);
  }
});
