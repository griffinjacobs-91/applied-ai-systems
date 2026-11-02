// The tradable universe, as the owner stated it: US-listed common stocks and ETFs,
// 20-day average volume over 500,000 shares, price over $2, no crypto proxies.
//
// "Real companies making real things. Screen out the momentum freaks of nature,
//  his example being the Bitcoin proxies that top every momentum list when
//  Bitcoin moves."   - rules doc, section 1, item 5

export const MIN_AVG_VOLUME_20D = 500_000;
export const MIN_PRICE = 2;

/** Listing types the owner's rule admits. Warrants, units, rights and preferreds are out. */
export const ALLOWED_TYPES = new Set(['CS', 'ETF']);

/**
 * Word test on the company name, from the rule doc. Matched case-insensitively
 * against the feed's `name` field.
 */
export const CRYPTO_NAME_WORDS = [
  'bitcoin', 'ether', 'ethereum', 'crypto', 'blockchain', 'digital asset',
  'digital currency', 'coinbase', 'solana', 'ripple', 'dogecoin', 'litecoin',
  'web3', 'defi ', 'stablecoin', 'satoshi',
];

/**
 * Hand-entered miner and treasury-proxy tickers. This list is a RULE
 * PARAMETER, not a fact taken from the feed: it is written down here so the
 * report can show exactly what was excluded and the owner can argue with it.
 * Anything the name test already catches is left off.
 */
export const CRYPTO_TICKERS = new Set([
  // bitcoin miners / hosts
  'MARA', 'RIOT', 'CLSK', 'HUT', 'BITF', 'CIFR', 'WULF', 'IREN', 'HIVE',
  'BTBT', 'CORZ', 'GREE', 'SDIG', 'ARBK', 'MIGI', 'SOS', 'CAN', 'EBON',
  'BTCM', 'DGHI', 'ANY', 'NCTY', 'BTDR', 'CANG', 'BTM', 'LMFA', 'XNET',
  'SLNH', 'CTM', 'GRIID', 'MGRX',
  // balance-sheet bitcoin proxies and crypto-native financials
  'MSTR', 'COIN', 'BKKT', 'HOOD', 'GLXY', 'BLOK', 'SMLR', 'NAKA', 'DFDV',
  'UPXI', 'SBET', 'BMNR', 'CEP',
]);

export function isCryptoProxy(ticker: string, name: string): boolean {
  if (CRYPTO_TICKERS.has(ticker)) return true;
  const n = name.toLowerCase();
  return CRYPTO_NAME_WORDS.some((w) => n.includes(w));
}

/**
 * Leveraged and inverse ETFs. Not one of the owner's stated rules, so they are NOT
 * excluded by default; the flag exists only so the report can say how much of
 * the result came from them. He does buy 2x funds deliberately (section 4).
 */
export function isLeveraged(name: string): boolean {
  const n = name.toLowerCase();
  return /\b(2x|3x|-1x|ultra|ultrapro|daily .* bull|daily .* bear|inverse|leveraged)\b/.test(n);
}
