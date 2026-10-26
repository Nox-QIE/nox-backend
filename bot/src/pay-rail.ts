/**
 * Payment rail by account country (F14-D04, process 8.1.2). ADR-003: buyers in Indonesia pay in
 * rupiah (an invoice for the MVP, a PSP later) and the operator records the pass on chain; everyone
 * else pays in QIE or QUSDC from their own wallet. Telegram does not tell a bot where a user lives,
 * so the first guess comes from the account's language and the player can correct it (/negara).
 */
export type PayRail = "rupiah" | "onchain";

export const payRail = (country: string | null | undefined): PayRail => (country === "ID" ? "rupiah" : "onchain");

/** An Indonesian-language Telegram account is most likely in Indonesia; other languages say nothing. */
export const countryGuess = (languageCode: string | undefined): string | null => (languageCode?.toLowerCase().startsWith("id") ? "ID" : null);

/** A two-letter country code (ISO 3166-1 alpha-2), upper case, or null. */
export const parseCountry = (s: string | undefined): string | null => (s && /^[A-Za-z]{2}$/.test(s.trim()) ? s.trim().toUpperCase() : null);
