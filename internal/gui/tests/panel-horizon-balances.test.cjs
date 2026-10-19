// Run with Node's test runner and Playwright on the module path; see README.md.
// The tray panel's Usage tab, with the Next 5 hours section ordered between
// two balance cards: the balance run is split there, so the section stands
// between the two balance sections, as the usage order puts it. Chromium and
// WebKit, English; no backend, the API is faked here.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");

// minutes from now, as the fixtures are served (never a fixed date: the page
// reads the real clock)
const at = (m) => new Date(Date.now() + m * 60e3).toISOString();

// two balances either side of the five hours, and a Codex window that starts
// again within five hours
const quotas = () => [
  { provider: "deepseek", name: "DeepSeek", icon: "deepseek", balance: "$12.40" },
  { provider: "sudocode", name: "SudoCode", icon: "generic", balance: "$3.00" },
  { provider: "codex", name: "Codex", icon: "codex-color", user: "a@x.dev", readAt: at(-1), windows: [{ name: "5 hours", used: 40, resetsAt: at(60) }] },
];

// the usage order: a balance, the five hours, a balance, then the rest
const usageOrder = ["deepseek", "next5h", "sudocode", "codex"];

function serve(lang, theme, panel, settings) {
  return async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"${theme}",web:${!panel}};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings });
    if (url.pathname === "/api/settings") {
      if (req.method() === "POST") Object.assign(settings, req.postDataJSON());
      return json(settings);
    }
    if (url.pathname === "/api/usage/arrange") {
      const body = req.postDataJSON() || {};
      if (body.order) settings.usageOrder = body.order;
      if (body.panelHidden) settings.panelUsageHidden = body.panelHidden;
      return json(settings);
    }
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true } });
    if (url.pathname === "/api/usage/quotas") return json(quotas());
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
  };
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  test(`${engine}: the Next 5 hours section stands between the two balances the order puts around it`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    const page = await (await browser.newContext({ viewport: { width: 400, height: 900 }, colorScheme: "light" })).newPage();
    t.after(async () => {
      try {
        if (process.env.ARTIFACT_DIR) {
          await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-panel-horizon.png`) });
        }
      } finally {
        await browser.close();
      }
    });
    const settings = { theme: "light", lang: "en", tray: "panel", currency: "usd", quotaLeft: true, usageOrder };
    const errors = [];
    page.setDefaultTimeout(5000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", serve("en", "light", true, settings));
    await page.goto("http://magpie.test/?mode=panel");
    await page.locator('#ptabs [data-ptab="usage"]').click();
    await page.locator('#panelQuota > [data-key="next5h"]').waitFor();

    // the panel draws again as the reads come in: wait for the order to settle
    const keys = () => page.locator("#panelQuota > .pq-group").evaluateAll((gs) => gs.map((g) => g.dataset.key));
    await page.waitForFunction((want) => {
      const got = [...document.querySelectorAll("#panelQuota > .pq-group")].map((g) => g.dataset.key);
      return got.length === want.length && got.every((k, i) => k === want[i]);
    }, usageOrder, { timeout: 3000 }).catch(async () => assert.fail(`the panel's sections, in order: ${JSON.stringify(await keys())}`));
    assert.deepEqual(await keys(), usageOrder, "the five hours' section between the two balances, as the order puts it");

    // two balance sections, not one run: DeepSeek's, then SudoCode's
    const first = await page.locator('#panelQuota > .pq-group[data-key="deepseek"]').textContent();
    const second = await page.locator('#panelQuota > .pq-group[data-key="sudocode"]').textContent();
    assert.ok(first.includes("DeepSeek") && !first.includes("SudoCode"), `the first balance's section: ${first}`);
    assert.ok(second.includes("SudoCode"), `the second balance's section: ${second}`);
    assert.deepEqual(errors, []);
  });
}
