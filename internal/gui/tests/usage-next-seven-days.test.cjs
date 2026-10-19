// Run with Node's test runner and Playwright on the module path; see README.md.
// The Usage page's Next 7 days card, drawn by the Next 5 hours card's code
// (usage-next-five-hours.test.cjs) over a week: the windows longer than five
// hours that start again within seven days, each a bar at its time on a
// 280px chart (a 5-hour window, by any of its names, is the other card's; a
// month's is taken; one past seven days isn't), the days' midnights dashed
// on the left half and named by their weekday in the language, 1D…7D on the
// right, a window not started waiting above. Now's name ("Sat 09:55") sits
// under the chart's foot when a bar about to start again would lie on it,
// and on the five hours' card when a full hour just after now would. The
// tooltip says a reset days away in days and hours. The card comes after the
// five hours' until it is moved, isn't drawn for a user with 5-hour windows
// alone, and the tray panel draws it 240px high, its arranging hiding it.
// The page's clock and time zone are pinned, and the midnights are checked
// across the end of daylight saving time in Los Angeles. Chromium and
// WebKit, every language, light and dark; no backend, the API is faked.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");
const { reach } = require("./reader.cjs");
const { strings } = require("./strings.cjs");

const assets = path.resolve(__dirname, "../assets");
const { I18N } = strings();
const tr = (lang, key, vars = {}) => (lang === "en" ? key : I18N[lang]?.[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k]);
const DAY = 1440, SPAN = 7 * DAY;

// minutes from T, the pinned now
const at = (T, m) => new Date(T + m * 60e3).toISOString();
const sets = {
  // a Saturday morning in Shanghai, five minutes before ten
  week: (T) => [
    { provider: "claude", name: "Claude Code", icon: "claude-color", plan: "max", user: "dee@example.com", readAt: at(T, -1), windows: [
      { name: "5 hours", used: 40, resetsAt: at(T, 120) },
      { name: "7 days", used: 30, startsAt: at(T, 1200 - SPAN), resetsAt: at(T, 1200) },
      { name: "7 days · Opus", used: 10, resetsAt: at(T, 30) },
    ] },
    { provider: "codex", name: "Codex", icon: "codex-color", user: "a@x.dev", readAt: at(T, -1), windows: [{ name: "Weekly", used: 55, resetsAt: at(T, 3 * DAY) }] },
    { provider: "minimax", name: "MiniMax", icon: "minimax-color", readAt: at(T, -1), windows: [
      { name: "7 days", used: 20, resetsAt: at(T, 6 * DAY) },
      { name: "5h", used: 5, resetsAt: at(T, 200) },
    ] },
    { provider: "kimi", name: "Kimi", icon: "kimi", readAt: at(T, -1), windows: [
      { name: "Monthly", used: 70, resetsAt: at(T, 5 * DAY) },
      { name: "7 days", used: 1, resetsAt: at(T, 8 * DAY) },
    ] },
    // nothing used, its reset a whole week after it was read: not started
    { provider: "antigravity", name: "Antigravity", icon: "antigravity-color", user: "s@x.dev", readAt: at(T, -1), windows: [{ name: "Gemini · 7 days", used: 0, resetsAt: at(T, SPAN - 1) }] },
  ],
  // 5-hour windows alone: no week to show
  short: (T) => [{ provider: "zai", name: "Z.ai", icon: "zai", readAt: at(T, -1), windows: [{ name: "5 hours", used: 30, resetsAt: at(T, 100) }] }],
  // across the end of daylight saving time (Los Angeles, Sunday Nov 1 2026)
  dst: (T) => [{ provider: "codex", name: "Codex", icon: "codex-color", user: "a@x.dev", readAt: at(T, -1), windows: [{ name: "Weekly", used: 40, resetsAt: at(T, 4 * DAY) }] }],
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

const runs = [["en", "light"], ["zh", "dark"], ["zh-TW", "light"], ["ja", "dark"], ["de", "light"]];
for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const [lang, theme] of runs) {
    test(`${engine} ${lang} ${theme}: the Next 7 days card draws the longer windows over the week`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      const pages = [];
      t.after(async () => {
        if (process.env.ARTIFACT_DIR) {
          await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
          for (const [name, p] of pages) await p.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-${lang}-next7-${name}.png`) });
        }
        await browser.close();
      });
      const T = Date.parse("2026-10-17T09:55:00+08:00");
      const settings = { theme, lang, tray: "panel", currency: "usd", quotaLeft: true };
      const saved = [], errors = [], set = { name: "week", T };
      const open = async (name, url, viewport) => {
        const context = await browser.newContext({ viewport, colorScheme: theme, timezoneId: "Asia/Shanghai" });
        const page = await context.newPage();
        pages.push([name, page]);
        page.setDefaultTimeout(5000);
        page.on("pageerror", (e) => errors.push(e.message));
        await page.clock.install({ time: T });
        // the page's own refresh off (every 5 s draws the cards anew): a bar
        // reached for and hovered stays the bar it was (sess-agent-strip)
        await page.addInitScript(() => { try { localStorage.setItem("magpie.usageEvery", "0"); } catch {} });
        await page.route("**/*", serve(lang, theme, url.includes("mode=panel"), settings, saved, set));
        await page.goto(url);
        return page;
      };
      const page = await open("usage", "http://magpie.test/?view=usage", { width: 1100, height: 760 });
      const week = page.locator('#subscriptionUsage > [data-key="next7d"]'), five = page.locator('#subscriptionUsage > [data-key="next5h"]');
      await week.waitFor();
      // after the five hours' card, both before the accounts', until they are moved
      const keys = await page.locator("#subscriptionUsage > [data-key]").evaluateAll((cs) => cs.map((c) => c.dataset.key));
      assert.deepEqual(keys.slice(0, 2), ["next5h", "next7d"], "the five hours', then the week's, first");
      assert.equal(await week.locator(".subscription-head > b").textContent(), tr(lang, "Next 7 days"));
      assert.match(await week.locator(".n5-next").textContent(), new RegExp("^" + tr(lang, "Next reset")));

      const c = await chart(week);
      assert.equal(Math.round(c.span), 284, "the week's chart is 280px, 4 under it");
      assert.equal(Math.round(c.H), c.under ? 266 : 280, "now's name under the foot takes its room from the chart, not the card");
      // the windows' names as the page says them
      const names = await page.evaluate((ns) => Object.fromEntries(ns.map((n) => [n, t(n)])), ["7 days", "7 days · Opus", "Weekly", "Monthly"]);
      const name = (w) => names[w];
      const has = (prefix, w) => c.bars.some((b) => b.who.startsWith(prefix) && b.who.includes(" · " + name(w) + " · "));
      // the windows longer than five hours within the week, a month's too
      for (const [who, w] of [["Claude Code", "7 days"], ["Claude Code", "7 days · Opus"], ["Codex", "Weekly"], ["MiniMax", "7 days"], ["Kimi", "Monthly"]]) assert.ok(has(who, w), `${who} ${w} is on the week's card: ${JSON.stringify(c.bars.map((b) => b.who))}`);
      assert.equal(c.bars.length, 5, "no 5-hour window, and no window past seven days");
      assert.equal(c.waiting, 1, "Antigravity's week not started waits above the chart");
      // each at its time, a day 40px (the one about to start again is held inside the chart)
      for (const [who, w, m] of [["Claude Code", "7 days", 1200], ["Codex", "Weekly", 3 * DAY], ["Kimi", "Monthly", 5 * DAY], ["MiniMax", "7 days", 6 * DAY]]) {
        // (bars are in the order they start again: "7 days · Opus", sooner, holds "7 days" too)
        const b = c.bars.find((x) => x.who.startsWith(who) && x.who.includes(" · " + name(w) + " · ") && !x.who.includes(name("7 days · Opus")) === (w !== "7 days · Opus"));
        assert.ok(Math.abs(b.y - c.H * (1 - m / SPAN)) < 3, `${who} ${w} at its time: ${b.y}`);
      }
      // the seven midnights after now at their places, named by their weekday
      const midnights = [1, 2, 3, 4, 5, 6, 7].map((d) => Date.parse(`2026-10-${17 + d}T00:00:00+08:00`)).filter((ms) => ms < T + SPAN * 60e3);
      const days = await page.evaluate((ms) => ms.map((x) => new Date(x).toLocaleDateString(intlLang(), { weekday: "short" })), midnights);
      assert.deepEqual(c.marks.map((m) => m.name), days, "the midnights, by weekday in the language");
      c.marks.forEach((m, k) => assert.ok(Math.abs(m.y - c.H * (1 - (midnights[k] - T) / (SPAN * 60e3))) < 1.5, `${days[k]} at its midnight: ${m.y}`));
      assert.deepEqual(c.units, ["1D", "2D", "3D", "4D", "5D", "6D", "7D"]);
      // Kimi's week, past seven days, in the row over the chart: its label on
      // one line and clear of the donut in every language ("Further off" was
      // two lines over it in a 26px box)
      const far = await week.evaluate((c) => {
        const l = c.querySelector(".n5-far .lab"), d = c.querySelector(".n5-far .n5-d");
        const words = document.createRange();
        words.selectNodeContents(l);
        return { label: l.textContent, lines: new Set([...words.getClientRects()].map((r) => Math.round(r.top))).size, clear: l.getBoundingClientRect().right <= d.getBoundingClientRect().left, who: d.getAttribute("aria-label").split(" ")[0] };
      });
      assert.deepEqual(far, { label: tr(lang, "Further off"), lines: 1, clear: true, who: "Kimi" }, `the row further off: ${JSON.stringify(far)}`);
      // now's name, wider than the names' room, under the foot while a bar
      // about to start again is on it; on the five hours' card under it
      // too, for 10:00 is five minutes off
      const nowName = await page.evaluate((T) => new Date(T).toLocaleDateString(intlLang(), { weekday: "short" }) + " " + new Date(T).toLocaleTimeString(intlLang(), { hour: "2-digit", minute: "2-digit", hour12: false }), T);
      assert.equal(c.now, nowName, "now by its weekday and time");
      assert.ok(c.under, "now's name goes under the foot, the Opus window's bar over it");
      assert.ok(c.room >= 8, `now's name under the foot is clear of the card's edge: ${c.room}px`);
      const f = await chart(five);
      assert.ok(f.under, "and on the five hours' card, 10:00's name over it");
      assert.ok(f.bars.some((b) => b.who.includes(" · " + name("7 days · Opus") + " · ")), "a week's window starting again within five hours is on the five hours' card too");
      assert.ok(!f.bars.some((b) => b.who.includes(" · " + name("Weekly") + " · ")), "and one days away isn't");

      // the tooltip: a reset days away in days and hours
      // reached by its card, which stays: the clock draws the bars anew, so a
      // bar found before a wheel can be another after it
      const codex = week.locator(".n5-item").nth(c.bars.findIndex((b) => b.who.startsWith("Codex")));
      await reach(page, week);
      await codex.hover();
      const tip = page.locator(".n5-tip.on");
      await tip.waitFor({ timeout: 300 });
      const said = await tip.textContent();
      assert.ok(said.includes(tr(lang, "{d}d {h}h", { d: 2, h: 23 })), `the reset 2 days 23 hours off: ${said}`);
      await page.mouse.move(2, 2);

      // the tray panel: its own section, 240px; the arranging hides it
      const panel = await open("panel", "http://magpie.test/?mode=panel", { width: 400, height: 680 });
      await panel.locator('#ptabs [data-ptab="usage"]').click();
      await panel.locator('#panelQuota > [data-key="next7d"]').waitFor();
      await panel.waitForFunction(() => { const p = document.querySelector('#panelQuota > [data-key="next7d"] .n5-plot'); const h = p && Math.round(p.getBoundingClientRect().height + parseFloat(getComputedStyle(p).marginBottom)); return h >= 244 && h <= 384; }, null, { timeout: 2000 })
        .catch(() => assert.fail("the panel's week is 240px, 4 under it, grown to 380px at most where its rows need it"));
      const arrange = panel.locator("#panelQuota .pq-arrange");
      await reach(panel, arrange);
      await arrange.click();
      const row = panel.locator('#panelQuota .pq-arow[data-key="next7d"]');
      assert.equal(await row.locator(".pq-aname").textContent(), tr(lang, "Next 7 days"));
      await reach(panel, row.locator(".pq-show"));
      await row.locator(".pq-show").click();
      for (let i = 0; i < 40 && !saved.length; i++) await panel.waitForTimeout(50);
      assert.deepEqual(saved.at(-1), { panelHidden: ["next7d"] });
      assert.deepEqual(errors, []);
    });
  }

  test(`${engine}: 5-hour windows alone draw no week`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const T = Date.parse("2026-10-17T09:55:00+08:00");
    const set = { name: "short", T }, errors = [];
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 }, timezoneId: "Asia/Shanghai" })).newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.clock.install({ time: T });
    await page.route("**/*", serve("en", "light", false, { theme: "light", lang: "en", currency: "usd" }, [], set));
    await page.goto("http://magpie.test/?view=usage");
    await page.locator('#subscriptionUsage > [data-key="next5h"]').waitFor();
    assert.equal(await page.locator('#subscriptionUsage > [data-key="next7d"]').count(), 0);
    assert.deepEqual(errors, []);
  });

  test(`${engine}: the week's midnights hold across the end of daylight saving time`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    // a Thursday morning in Los Angeles; clocks go back an hour early on Sunday
    const T = Date.parse("2026-10-29T10:00:00-07:00");
    const set = { name: "dst", T }, errors = [];
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 }, timezoneId: "America/Los_Angeles", locale: "en-US" })).newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.clock.install({ time: T });
    await page.route("**/*", serve("en", "light", false, { theme: "light", lang: "en", currency: "usd" }, [], set));
    await page.goto("http://magpie.test/?view=usage");
    const week = page.locator('#subscriptionUsage > [data-key="next7d"]');
    await week.waitFor();
    const c = await chart(week);
    // midnight is 07:00 UTC in daylight time, 08:00 from Sunday Nov 1
    const midnights = ["2026-10-30T07:00Z", "2026-10-31T07:00Z", "2026-11-01T07:00Z", "2026-11-02T08:00Z", "2026-11-03T08:00Z", "2026-11-04T08:00Z", "2026-11-05T08:00Z"].map(Date.parse);
    assert.deepEqual(c.marks.map((m) => m.name), ["Fri", "Sat", "Sun", "Mon", "Tue", "Wed", "Thu"]);
    c.marks.forEach((m, k) => assert.ok(Math.abs(m.y - c.H * (1 - (midnights[k] - T) / (SPAN * 60e3))) < 1.5, `${m.name} at its midnight: ${m.y}`));
    assert.deepEqual(errors, []);
  });
}
