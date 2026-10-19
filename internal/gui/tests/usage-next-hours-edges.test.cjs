// Run with Node's test runner and Playwright on the module path; see README.md.
// The Usage page's Next 5 hours card at three of its edges, in English and
// light only, with the page's clock and time zone pinned. In a half-hour zone
// (India) the full hours are the local clock's: at 09:40 the marks are 10:00
// to 14:00, each at its time on the 240px chart, not UTC's hours. Five
// accounts of one provider, used in turn so each resets a little after the
// last, are five bars and no "+N": they don't chain into one row of three.
// Two providers sharing a logo number their accounts apart, 1 and 2, not one
// account's 1 twice. Chromium and WebKit; no backend, the API is faked.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

// MAGPIE_EDGE_ASSETS serves another copy of the assets (the mutation checks)
const assets = process.env.MAGPIE_EDGE_ASSETS || path.resolve(__dirname, "../assets");

// minutes from T, the pinned now
const at = (T, m) => new Date(T + m * 60e3).toISOString();
const sets = {
  // a 09:40 morning in Kolkata: Codex's one window resets at 11:40
  half: (T) => [{ provider: "codex", name: "Codex", icon: "codex-color", user: "a@x.dev", readAt: at(T, -1), windows: [{ name: "5 hours", used: 40, resetsAt: at(T, 120) }] }],
  // five accounts of one provider used in turn, resetting 30, 60, 90, 120 and 150 minutes from now
  turn: (T) => [["a", 30], ["b", 60], ["c", 90], ["d", 120], ["e", 150]].map(([u, m]) => ({ provider: "codex", name: "Codex", icon: "codex-color", user: `${u}@x.dev`, readAt: at(T, -1), windows: [{ name: "5 hours", used: 30, resetsAt: at(T, m) }] })),
  // two providers on one logo: Codex's own account and the Codex plugin's
  logo: (T) => [
    { provider: "codex", name: "Codex", icon: "codex-color", user: "a@x.dev", readAt: at(T, -1), windows: [{ name: "5 hours", used: 20, resetsAt: at(T, 60) }] },
    { provider: "codex-plugin", name: "Codex (plugin)", icon: "codex-color", user: "b@x.dev", readAt: at(T, -1), windows: [{ name: "5 hours", used: 50, resetsAt: at(T, 200) }] },
  ],
};

function serve(lang, theme, panel, settings, saved, set) {
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
      const body = req.postDataJSON();
      saved.push(body);
      if (body.order) settings.usageOrder = body.order;
      if (body.panelHidden) settings.panelUsageHidden = body.panelHidden;
      return json(settings);
    }
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true } });
    if (url.pathname === "/api/usage/quotas") return json(sets[set.name](set.T));
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
  };
}

// a card's bars, marks, units and now's name, measured against its chart
const chart = (card) => card.evaluate((c) => {
  const p = c.querySelector(".n5-plot").getBoundingClientRect();
  const y = (e) => e.getBoundingClientRect().top - p.top;
  const plot = c.querySelector(".n5-plot"), now = c.querySelector(".n5-now");
  return {
    H: p.height,
    // the chart and the room under it, the same whichever side of the foot
    // now's name is on; and what is left between that name and the card's edge
    span: p.height + parseFloat(getComputedStyle(plot).marginBottom),
    room: c.getBoundingClientRect().bottom - now.getBoundingClientRect().bottom,
    bars: [...c.querySelectorAll(".n5-item")].map((i) => ({ who: i.getAttribute("aria-label"), y: i.querySelector(".n5-bar").getBoundingClientRect().top + i.querySelector(".n5-bar").getBoundingClientRect().height / 2 - p.top, left: i.getBoundingClientRect().left - p.left })),
    marks: [...c.querySelectorAll(".n5-hour")].map((e, k) => ({ y: y(e), name: c.querySelectorAll(".n5-clock")[k].textContent })),
    units: [...c.querySelectorAll(".n5-in")].map((e) => e.textContent),
    now: c.querySelector(".n5-now").textContent, under: c.querySelector(".n5-now").classList.contains("under"),
    waiting: c.querySelectorAll(".n5-wait .logos > span").length,
  };
});

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  // the Usage page in English and light, its clock at T and its zone the given one
  const open = async (browser, pages, errors, { T, zone, set }) => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, colorScheme: "light", timezoneId: zone });
    const page = await context.newPage();
    pages.push(page);
    page.setDefaultTimeout(5000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.clock.install({ time: T });
    const settings = { theme: "light", lang: "en", tray: "panel", currency: "usd", quotaLeft: true };
    await page.route("**/*", serve("en", "light", false, settings, [], set));
    await page.goto("http://magpie.test/?view=usage");
    return page;
  };
  // the browser closes with the test; ARTIFACT_DIR keeps the pages' screenshots first
  const finish = (t, browser, pages, name) => t.after(async () => {
    if (process.env.ARTIFACT_DIR) {
      await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
      for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-${name}-${i}.png`) });
    }
    await browser.close();
  });

  test(`${engine}: the five hours' full hours are the local clock's in a half-hour zone`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    const pages = [], errors = [];
    finish(t, browser, pages, "half");
    // 09:40 in Kolkata, where the full hours fall on UTC's half hours: 10:00 to 14:00 there
    const T = Date.parse("2026-10-17T09:40:00+05:30");
    const page = await open(browser, pages, errors, { T, zone: "Asia/Kolkata", set: { name: "half", T } });
    const five = page.locator('#subscriptionUsage > [data-key="next5h"]');
    await five.waitFor();
    const c = await chart(five);
    assert.equal(Math.round(c.span), 244, "the five hours' chart is 240px, 4 under it");
    assert.equal(Math.round(c.H), c.under ? 226 : 240, "now's name under the foot takes its room from the chart");
    assert.equal(c.now, "09:40", "now on the local clock");
    assert.deepEqual(c.marks.map((m) => m.name), ["10:00", "11:00", "12:00", "13:00", "14:00"], "the full hours on the local clock; 15:00 is past five hours");
    // each at its time on the chart: 240px for the five hours from now
    const hours = [0, 1, 2, 3, 4].map((k) => Date.parse("2026-10-17T10:00:00+05:30") + k * 3600e3);
    c.marks.forEach((m, k) => assert.ok(Math.abs(m.y - c.H * (1 - (hours[k] - T) / (300 * 60e3))) < 1.5, `${m.name} at its time: ${m.y}`));
    assert.deepEqual(errors, []);
  });

  test(`${engine}: accounts used in turn don't make one row of them all`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    const pages = [], errors = [];
    finish(t, browser, pages, "turn");
    // 09:55 in Shanghai; the five accounts' windows reset 30, 60, 90, 120 and 150 minutes from now
    const T = Date.parse("2026-10-17T09:55:00+08:00");
    const page = await open(browser, pages, errors, { T, zone: "Asia/Shanghai", set: { name: "turn", T } });
    const five = page.locator('#subscriptionUsage > [data-key="next5h"]');
    await five.waitFor();
    // one row of them would be three bars and a "+2"
    assert.equal(await five.locator(".n5-more").count(), 0, "no +N for accounts used in turn");
    assert.equal(await five.locator(".n5-item").count(), 5, "all five accounts' bars are drawn");
    assert.deepEqual(errors, []);
  });

  test(`${engine}: two providers sharing a logo number their accounts apart`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    const pages = [], errors = [];
    finish(t, browser, pages, "logo");
    // 09:55 in Shanghai, as above; Codex's account and the Codex plugin's account both number 1
    const T = Date.parse("2026-10-17T09:55:00+08:00");
    const page = await open(browser, pages, errors, { T, zone: "Asia/Shanghai", set: { name: "logo", T } });
    const five = page.locator('#subscriptionUsage > [data-key="next5h"]');
    await five.waitFor();
    const marks = await five.locator(".n5-item .n5-mark").allTextContents();
    assert.deepEqual([...marks].sort(), ["1", "2"], `the two bars' corner marks: ${JSON.stringify(marks)}`);
    assert.deepEqual(errors, []);
  });
}
