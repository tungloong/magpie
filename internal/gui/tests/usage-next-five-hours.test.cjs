// Run with Node's test runner and Playwright on the module path; see README.md.
// The Usage page's Next 5 hours card: every window that starts again within
// five hours as a thin bar at its time, its logo and figure over it, filled
// with what is used or left as the other meters are (#122), in its logo's
// own colours read from the logo (a logo of none in the accent), each one
// standing 3:1 against the card. Bars too close in time to stand one over
// the other share a row, halves or thirds, the rest counted (+2). A window
// not started waits in a row above the chart. Hovering a bar, the count or
// a waiting logo shows its tooltip at once; leaving the card hides it, and
// the half-minute redraw keeps it on the bar under the pointer. The clock's
// full hours are dashed on the left half and the hours from now ruled on
// the right. The card follows the cards' order, says when nothing starts
// again in five hours, and isn't drawn when no window has a reset time. The
// tray panel's Usage tab draws it too, shorter, and its arranging moves and
// hides it. Chromium and WebKit, every language, both themes, at 1100 and
// 420 wide; no backend, the API is faked here.
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

// minutes from now, as the fixtures are served (never a fixed date: the page
// reads the real clock)
const at = (m) => new Date(Date.now() + m * 60e3).toISOString();
const sets = {
  // three running at 60, 150 and 240 minutes; Codex's second account not
  // started (nothing used, its reset a whole window after it was read)
  plain: () => [
    { provider: "claude", name: "Claude Code", icon: "claude-color", plan: "max", user: "dee@example.com", readAt: at(-1), windows: [
      { name: "5 hours", used: 70, startsAt: at(-150), resetsAt: at(150) },
      { name: "7 days", used: 20, resetsAt: at(5000) },
    ] },
    { provider: "codex", name: "Codex", icon: "codex-color", plan: "plus", user: "a@x.dev", readAt: at(-1), windows: [{ name: "5 hours", used: 40, resetsAt: at(60) }] },
    { provider: "codex", name: "Codex", icon: "codex-color", plan: "plus", user: "b@x.dev", readAt: at(-1), windows: [{ name: "5 hours", used: 0, resetsAt: at(299) }] },
    { provider: "kimi", name: "Kimi", icon: "kimi", readAt: at(-1), windows: [{ name: "5 hours", used: 10, resetsAt: at(240) }] },
  ],
  // two within five minutes of each other share a row, as do three; two half
  // an hour apart (24px on 240px) stand each at its own time, the chart grown
  // for them; six together are donuts
  busy: () => [
    ...[["claude", "Claude Code", "claude-color", 60], ["codex", "Codex", "codex-color", 62],
      ["minimax", "MiniMax", "minimax-color", 110], ["kimi", "Kimi", "kimi", 111], ["zai", "Z.ai", "zai", 113],
      ["openai", "OpenAI", "openai", 160], ["moonshot", "Moonshot", "moonshot", 190],
      ["deepseek", "DeepSeek", "deepseek-color", 240], ["qwen", "Qwen", "qwen-color", 240], ["gemini", "Gemini", "gemini-color", 241],
      ["kiro", "Kiro", "kiro-color", 241], ["grok", "Grok", "grok", 242], ["cursor", "Cursor", "cursor", 243]].map(([provider, name, icon, m]) =>
      ({ provider, name, icon, user: provider + "@x.dev", readAt: at(-1), windows: [{ name: "5 hours", used: 30, resetsAt: at(m) }] })),
  ],
  // more together than the card has room for at its ceiling: twenty at an
  // hour, sixteen forty minutes later, and one over them
  crowd: () => [
    ...Array.from({ length: 20 }, (_, i) => ({ provider: "codex", name: "Codex", icon: "codex-color", user: `a${i}@x.dev`, readAt: at(-1), windows: [{ name: "5 hours", used: 10 + i, resetsAt: at(60) }] })),
    ...Array.from({ length: 16 }, (_, i) => ({ provider: "claude", name: "Claude Code", icon: "claude-color", user: `b${i}@x.dev`, readAt: at(-1), windows: [{ name: "5 hours", used: 10 + i, resetsAt: at(100) }] })),
    { provider: "kimi", name: "Kimi", icon: "kimi", user: "k@x.dev", readAt: at(-1), windows: [{ name: "5 hours", used: 40, resetsAt: at(170) }] },
  ],
  // a reset, but none within five hours
  later: () => [{ provider: "claude", name: "Claude Code", icon: "claude-color", readAt: at(-1), windows: [{ name: "7 days", used: 20, resetsAt: at(5000) }] }],
  // no window with a reset time at all
  none: () => [{ provider: "kimi", name: "Kimi", icon: "kimi", windows: [{ name: "Weekly", used: 20 }] }],
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
    if (url.pathname === "/api/usage/quotas") return json(sets[set.name]());
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
  };
}

// each bar's place and colours, the card's own ground beside them, and
// whether each colour stands 3:1 against it (as the page reads a colour:
// a canvas says it back in one form)
const bars = (card) => card.evaluate((c) => {
  const plot = c.querySelector(".n5-plot").getBoundingClientRect();
  const cx = document.createElement("canvas").getContext("2d");
  const rgb = (v) => { cx.fillStyle = "#000"; cx.fillStyle = v; const s = cx.fillStyle; return s.startsWith("#") ? [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) : s.match(/[\d.]+/g).slice(0, 3).map(Number); };
  const lin = (x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => p - q); return (y + 0.05) / (x + 0.05); };
  const ground = rgb(getComputedStyle(document.body).getPropertyValue("--card").trim());
  return [...c.querySelectorAll(".n5-item")].map((i) => {
    const b = i.getBoundingClientRect(), bar = i.querySelector(".n5-bar").getBoundingClientRect(), s = getComputedStyle(i);
    const c1 = s.getPropertyValue("--c1").trim(), c2 = s.getPropertyValue("--c2").trim();
    return {
      who: i.getAttribute("aria-label"), pct: i.querySelector(".n5-pct").textContent, clip: i.querySelector(".n5-bar i").style.clipPath,
      own: i.style.getPropertyValue("--c1"), c1, left: b.left - plot.left, right: plot.right - b.right, width: b.width, plotW: plot.width,
      y: bar.top + bar.height / 2 - plot.top, mark: i.querySelector(".n5-mark")?.textContent || "",
      clear: Math.min(contrast(rgb(c1), ground), contrast(rgb(c2), ground)),
    };
  });
});

const runs = [["en", "light"], ["zh", "dark"], ["zh-TW", "light"], ["ja", "dark"], ["de", "light"]];
for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const [lang, theme] of runs) {
    test(`${engine} ${lang} ${theme}: the Next 5 hours card draws each window at its time, in its logo's colours`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      const pages = [];
      t.after(async () => {
        if (process.env.ARTIFACT_DIR) {
          await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
          for (const [name, p] of pages) await p.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-${lang}-next5-${name}.png`) });
        }
        await browser.close();
      });
      const settings = { theme, lang, tray: "panel", currency: "usd", quotaLeft: true, usageOrder: ["next5h"] };
      const saved = [], errors = [], set = { name: "plain" };
      const open = async (name, url, viewport) => {
        const page = await (await browser.newContext({ viewport, colorScheme: theme })).newPage();
        pages.push([name, page]);
        page.setDefaultTimeout(5000);
        page.on("pageerror", (e) => errors.push(e.message));
        await page.route("**/*", serve(lang, theme, url.includes("mode=panel"), settings, saved, set));
        await page.goto(url);
        return page;
      };
      const page = await open("usage", "http://magpie.test/?view=usage", { width: 1100, height: 760 });
      const card = page.locator('#subscriptionUsage > [data-key="next5h"]');
      await card.waitFor();
      assert.equal(await page.locator("#subscriptionUsage > .subscription-card").first().getAttribute("data-key"), "next5h", "first, where the order puts it");
      assert.equal(await card.locator(".subscription-head > b").textContent(), tr(lang, "Next 5 hours"));
      assert.match(await card.locator(".n5-next").textContent(), new RegExp("^" + tr(lang, "Next reset")));
      // the logos' colours are read once their pictures load
      await page.waitForFunction(() => document.querySelector('#subscriptionUsage .n5-item[aria-label^="Claude Code"]')?.style.getPropertyValue("--c1"));

      // three running, at their times (now at the bottom, five hours on at the top)
      let bs = await bars(card);
      const by = (name) => bs.find((b) => b.who.startsWith(name));
      assert.deepEqual(bs.map((b) => b.who.split(" ")[0]).sort(), ["Claude", "Codex", "Kimi"]);
      // 240px with 4 under it, less now's name's room when that is under the
      // foot (a full hour within twenty minutes: this test runs on the real clock)
      const [H, span, under] = await card.locator(".n5-plot").evaluate((p) => [p.getBoundingClientRect().height, p.getBoundingClientRect().height + parseFloat(getComputedStyle(p).marginBottom), p.classList.contains("under")]);
      assert.equal(Math.round(span), 244, "the page's chart is 240px, 4 under it");
      assert.equal(Math.round(H), under ? 226 : 240, "now's name under the foot takes its room from the chart");
      for (const [name, m] of [["Codex", 60], ["Claude Code", 150], ["Kimi", 240]]) assert.ok(Math.abs(by(name).y - H * (1 - m / 300)) < 3, `${name} at its time: ${by(name).y}`);
      // each alone, two thirds of the chart wide, clear of the names either side
      for (const b of bs) {
        assert.ok(Math.abs(b.width - Math.min(b.plotW * 2 / 3, b.plotW - 56)) < 1.5, `a bar alone is 2/3 wide: ${b.width} of ${b.plotW}`);
        assert.ok(b.left >= 34 - 0.5 && b.right >= 22 - 0.5, `clear of the clock and the hours: ${b.left}, ${b.right}`);
      }
      // the logo's own colour; a logo of none (Kimi's mask) in the accent;
      // every one 3:1 on the card in either theme
      assert.equal(by("Claude Code").own, "rgb(217 119 87)", "Claude Code's terracotta, read from its logo");
      assert.equal(by("Kimi").own, "", "a logo of no colour leaves the bar the accent");
      for (const b of bs) assert.ok(b.clear >= 3 - 0.05, `${b.who}: ${b.clear.toFixed(2)}:1 on the card`);
      // left, as the page's meters show it: Claude 70% used is 30% left,
      // filled to 30%; the corner marks tell Codex's two accounts apart
      assert.equal(by("Claude Code").pct, "30%");
      assert.match(by("Claude Code").clip, /^inset\(0(px)? 70% 0(px)? 0(px)? round/);
      assert.equal(by("Codex").mark, "1");
      const waiting = card.locator(".n5-wait .logos > span");
      assert.equal(await waiting.count(), 1, "Codex's second account waits above the chart");
      assert.equal(await waiting.locator(".n5-mark").textContent(), "2");
      assert.equal(await card.locator(".n5-wait .lab").textContent(), tr(lang, "Not started"));

      // the full hours dashed on the left half, the hours from now ruled on the right
      const lines = await card.evaluate((c) => {
        const p = c.querySelector(".n5-plot").getBoundingClientRect();
        const span = (sel) => [...c.querySelectorAll(sel)].map((e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left - p.left), Math.round(p.right - b.right)]; });
        return { hours: span(".n5-hour"), rules: span(".n5-rule"), in: [...c.querySelectorAll(".n5-in")].map((e) => e.textContent), w: p.width };
      });
      assert.deepEqual(lines.in, ["1H", "2H", "3H", "4H", "5H"]);
      for (const [l, r] of lines.hours) assert.ok(l === 0 && Math.abs(r - lines.w / 2) <= 1, `a full hour from the left to the middle: ${l}, ${r}`);
      for (const [l, r] of lines.rules) assert.ok(r === 0 && Math.abs(l - lines.w / 2) <= 1, `an hour from now from the right to the middle: ${l}, ${r}`);

      // hovering: at once, with the account, the window, its reset and pace
      const tip = page.locator(".n5-tip.on");
      const scroll = () => page.locator("#view-usage").evaluate((v) => v.scrollTop);
      const claude = card.locator('.n5-item[aria-label^="Claude Code"]');
      await reach(page, claude);
      const before = await scroll();
      await claude.hover();
      await tip.waitFor({ timeout: 300 });
      const said = await tip.textContent();
      for (const want of ["Claude Code", "dee@example.com", tr(lang, "5 hours"), tr(lang, "{n} left", { n: "30%" }), tr(lang, "Pace {n}", { n: "" }).trim()]) assert.ok(said.includes(want), `the tooltip says ${want}: ${said}`);
      // drawn again by the clock under a still pointer: still there
      await page.evaluate(() => next5Fill(next5Els.get("next5h")));
      assert.equal(await tip.count(), 1, "the redraw keeps the tooltip");
      // the whole page drawn again (a new reading every minute) builds the
      // card before it is in the page: the tooltip stays by its bar, not in
      // the window's corner
      await page.evaluate(() => renderQuotas());
      const near = await page.evaluate(() => {
        const t = document.querySelector(".n5-tip.on")?.getBoundingClientRect();
        const b = [...document.querySelectorAll("#subscriptionUsage .n5-item")].find((i) => i.getAttribute("aria-label").startsWith("Claude Code"))?.getBoundingClientRect();
        return t && b ? { dx: Math.abs(t.left - b.left), gap: Math.min(Math.abs(t.bottom - b.top), Math.abs(t.top - b.bottom)) } : null;
      });
      assert.ok(near && near.dx < 2 && near.gap < 12, `the tooltip by its bar after the page is drawn again: ${JSON.stringify(near)}`);
      // the waiting logo: not started, counted from its first use
      await waiting.first().hover();
      assert.ok((await tip.textContent()).includes(tr(lang, "The window starts counting from its first use")));
      await page.mouse.move(2, 2);
      assert.equal(await tip.count(), 0, "gone once the pointer leaves the card");
      assert.equal(await scroll(), before, "no hover moves the page");

      // used, when the page's meters show what is used: 70%, filled to 70%
      const used = page.locator("#quotaMode .opt").first();
      await reach(page, used);
      await used.click();
      await page.waitForFunction(() => document.querySelector('#subscriptionUsage .n5-item[aria-label^="Claude Code"] .n5-pct')?.textContent === "70%");
      assert.match((await bars(card)).find((b) => b.who.startsWith("Claude Code")).clip, /^inset\(0(px)? 30% 0(px)? 0(px)? round/);

      // narrow: every bar and name inside the card
      await page.setViewportSize({ width: 420, height: 760 });
      await page.waitForTimeout(300);
      bs = await bars(card);
      for (const b of bs) assert.ok(b.left >= 0 && b.right >= 0, `inside at 420: ${b.left}, ${b.right}`);
      assert.ok(await card.evaluate((c) => c.scrollWidth <= c.clientWidth + 1), "nothing wider than the card at 420");

      // the tray panel: its own section, 200px, in the same order; its
      // arranging lists it, and hides it from the panel alone
      const panel = await open("panel", "http://magpie.test/?mode=panel", { width: 400, height: 680 });
      await panel.locator('#ptabs [data-ptab="usage"]').click();
      const group = panel.locator('#panelQuota > [data-key="next5h"]');
      await group.waitFor();
      assert.equal(await panel.locator("#panelQuota > .pq-group").first().getAttribute("data-key"), "next5h");
      // the panel draws its tab again as its reads come in, and a section read
      // as it is replaced measures 0: the height of the one in the tab
      await panel.waitForFunction(() => { const p = document.querySelector('#panelQuota > [data-key="next5h"] .n5-plot'); return p && Math.round(p.getBoundingClientRect().height + parseFloat(getComputedStyle(p).marginBottom)) === 204; }, null, { timeout: 2000 })
        .catch(() => assert.fail("the panel's chart is 200px, 4 under it (less now's name's room when that is under its foot)"));
      assert.equal(await group.locator(".n5-item").count(), 3);
      const arrange = panel.locator("#panelQuota .pq-arrange");
      await reach(panel, arrange);
      await arrange.click();
      const row = panel.locator('#panelQuota .pq-arow[data-key="next5h"]');
      assert.equal(await row.locator(".pq-aname").textContent(), tr(lang, "Next 5 hours"));
      await reach(panel, row.locator(".pq-show"));
      await row.locator(".pq-show").click();
      await panel.waitForFunction(() => !document.querySelector('#panelQuota .pq-arow[data-key="next5h"] .pq-show')?.getAttribute("aria-pressed")?.startsWith("t"));
      for (let i = 0; i < 40 && !saved.length; i++) await panel.waitForTimeout(50);
      assert.deepEqual(saved.at(-1), { panelHidden: ["next5h"] });
      await reach(panel, panel.locator("#panelQuota .pq-done"));
      await panel.locator("#panelQuota .pq-done").click();
      assert.equal(await group.count(), 0, "hidden from the panel");
      assert.equal(await panel.locator("#panelQuota .pq-hidden").textContent(), tr(lang, "{n} hidden", { n: 1 }));
      assert.deepEqual(errors, []);
    });
  }

  test(`${engine}: windows starting again together share a row, more than three as donuts, and a few minutes apart each stands at its own time`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const settings = { theme: "light", lang: "en", tray: "panel", currency: "usd", quotaLeft: true, usageOrder: ["next5h"] };
    const errors = [], set = { name: "busy" };
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", serve("en", "light", false, settings, [], set));
    await page.goto("http://magpie.test/?view=usage");
    const card = page.locator('#subscriptionUsage > [data-key="next5h"]');
    await card.waitFor();
    // drawn again once its width is known: the donuts' lines are the width's
    await page.waitForFunction(() => document.querySelectorAll('#subscriptionUsage > [data-key="next5h"] .n5-d').length === 6);
    const bs = await bars(card);
    assert.equal(bs.length, 7, "two in a row of two, three in a row of three, two alone");
    const W = bs[0].plotW, room = W - 56;
    const who = (n) => bs.filter((b) => n.some((x) => b.who.startsWith(x)));
    const pair = who(["Claude", "Codex"]), three = who(["MiniMax", "Kimi", "Z.ai"]), apart = who(["OpenAI", "Moonshot"]);
    for (const b of pair) assert.ok(Math.abs(b.width - (room - 8) / 2) < 1.5, `a half: ${b.width}`);
    assert.ok(pair[0].left + pair[0].width <= pair[1].left - 7, "side by side, apart");
    for (const b of three) assert.ok(Math.abs(b.width - (room - 2 * 8) / 3) < 1.5, `a third: ${b.width}`);
    assert.deepEqual(three.map((b) => b.who.split(" ")[0]), ["MiniMax", "Kimi", "Z.ai"], "in the order they start again");
    // half an hour apart: 24px on 240px, so the chart grows until they stand clear, each at its own time
    const H = await card.locator(".n5-plot").evaluate((p) => p.getBoundingClientRect().height);
    assert.ok(H > 240 && H <= 420, `the chart grew for them: ${H}`);
    for (const [b, m] of [[apart[0], 160], [apart[1], 190]]) assert.ok(Math.abs(b.y - H * (1 - m / 300)) < 2, `${b.who} at its time: ${b.y}`);
    assert.ok(apart[0].y - apart[1].y >= 28, "the later one 28px over the earlier");
    // six together: a row of donuts, each its own window
    const blk = card.locator(".n5-blk");
    assert.equal(await blk.count(), 1);
    const ds = blk.locator(".n5-d");
    assert.deepEqual((await ds.evaluateAll((d) => d.map((x) => x.getAttribute("aria-label").split(" ")[0]))), ["DeepSeek", "Qwen", "Gemini", "Kiro", "Grok", "Cursor"]);
    assert.ok((await ds.first().locator(".n5-dpct").textContent()).endsWith("%"));
    await reach(page, ds.nth(2));
    await ds.nth(2).hover();
    const said = await page.locator(".n5-tip.on").textContent();
    assert.ok(said.includes("Gemini") && !said.includes("Kiro"), `the donut's own tooltip: ${said}`);
    // its guide at the row's time, the first's to the last's
    assert.match(await card.locator(".n5-blk + .n5-guide span").textContent(), /^\d\d:\d\d–\d\d:\d\d$/);
    assert.deepEqual(errors, []);
  });

  test(`${engine}: at its ceiling a row of donuts shows the lines it has room for and counts the rest`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const settings = { theme: "light", lang: "en", tray: "panel", currency: "usd", quotaLeft: true, usageOrder: ["next5h"] };
    const errors = [], set = { name: "crowd" };
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", serve("en", "light", false, settings, [], set));
    await page.goto("http://magpie.test/?view=usage");
    const card = page.locator('#subscriptionUsage > [data-key="next5h"]');
    await card.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('#subscriptionUsage > [data-key="next5h"] .n5-blk').length === 2);
    const span = await card.locator(".n5-plot").evaluate((p) => p.getBoundingClientRect().height + parseFloat(getComputedStyle(p).marginBottom));
    assert.equal(Math.round(span), 424, "420px at most, 4 under it");
    const rows = await card.locator(".n5-blk").evaluateAll((bs) => bs.map((b) => ({ shown: b.querySelectorAll(".n5-d").length, more: b.querySelector(".n5-dmore")?.textContent || "" })));
    for (const r of rows) assert.equal(r.shown + (r.more ? +r.more.slice(1) : 0), [20, 16][rows.indexOf(r)], `every window shown or counted: ${JSON.stringify(rows)}`);
    assert.ok(rows[0].more, "the earlier row has no room for all twenty under the later");
    // each row stands clear of the next one's time
    const tops = await card.locator(".n5-blk").evaluateAll((bs) => bs.map((b) => [b.getBoundingClientRect().top, b.getBoundingClientRect().bottom]));
    const g = await card.locator(".n5-blk + .n5-guide").evaluateAll((gs) => gs.map((x) => x.getBoundingClientRect().top + 1));
    assert.ok(tops[0][0] >= g[1] + 3, `the first row's top clear of the second's time: ${tops[0][0]} ${g[1]}`);
    const more = card.locator(".n5-dmore").first();
    await reach(page, more);
    await more.hover();
    assert.ok((await page.locator(".n5-tip.on .n5-tip-part").count()) === +(await more.textContent()).slice(1), "the count's tooltip tells each it stands for");
    assert.equal(await card.locator(".n5-item").count(), 1, "the one over them a bar");
    assert.deepEqual(errors, []);
  });

  test(`${engine}: with nothing within five hours the card says so, and with no reset time there is none`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    for (const lang of ["en", "zh"]) {
      const settings = { theme: "light", lang, tray: "panel", currency: "usd", quotaLeft: true };
      const errors = [], set = { name: "later" };
      const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 } })).newPage();
      page.setDefaultTimeout(5000);
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", serve(lang, "light", false, settings, [], set));
      await page.goto("http://magpie.test/?view=usage");
      const card = page.locator('#subscriptionUsage > [data-key="next5h"]');
      await card.waitFor();
      assert.equal(await card.locator(".n5-empty").textContent(), tr(lang, "Nothing starts again in the next 5 hours"));
      assert.ok(await card.locator(".n5-empty").isVisible() && !(await card.locator(".n5-plot").isVisible()));
      assert.equal(await card.locator(".n5-next").textContent(), "", "no next reset to tell");
      set.name = "none";
      await page.reload();
      await page.locator("#subscriptionUsage > .subscription-card").first().waitFor();
      assert.equal(await card.count(), 0, "no window with a reset time: no card");
      assert.deepEqual(errors, []);
    }
  });
}
