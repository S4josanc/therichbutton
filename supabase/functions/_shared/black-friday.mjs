// The campaign runs on 27 November in Europe/Bratislava (CET).
export const BLACK_FRIDAY = 'black-friday-2026';
export const BLACK_FRIDAY_START = Date.parse('2026-11-26T23:00:00Z') / 1000;
export const BLACK_FRIDAY_END = Date.parse('2026-11-27T23:00:00Z') / 1000;
export const LIST_CENTS = Object.freeze({
  'rich-gift': 4900, gold: 49900, platinum: 199900, diamond: 999900,
});

export function isBlackFriday(seconds) {
  return Number.isSafeInteger(seconds) && seconds >= BLACK_FRIDAY_START && seconds < BLACK_FRIDAY_END;
}

export function quotePrice(product, seconds) {
  if (!Object.hasOwn(LIST_CENTS, product)) return null;
  const list = LIST_CENTS[product];
  return isBlackFriday(seconds)
    ? { cents: list / 2, campaign: BLACK_FRIDAY }
    : { cents: list, campaign: null };
}
