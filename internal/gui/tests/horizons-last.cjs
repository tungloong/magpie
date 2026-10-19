// The Next 5 hours and Next 7 days cards stand first on the Usage page and
// in the tray panel until a reader moves them. A test of another card's own
// behaviour puts them after its cards, as a reader who dragged them there
// would, so what it clicks and measures is where it was written for: an
// order (settings.usageOrder) naming the fixture's cards in their order,
// then the two. See usage-next-five-hours.test.cjs for the cards themselves.
exports.horizonsLast = (quotas) => [...new Set(quotas.map((q) => q.provider)), "next5h", "next7d"];
