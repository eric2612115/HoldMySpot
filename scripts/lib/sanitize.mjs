// Sanitizes a PayPal REST response before it is saved as a test fixture
// (server/test/paypal/fixtures/recorded). Keeps ids, statuses, amounts, timestamps and our own
// invoice and custom ids; drops emails, names, payer and merchant ids, addresses, phone numbers,
// tokens and the query string of every link (approval links carry a token).

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_ANYWHERE = /[^\s@"<>]+@[^\s@"<>]+\.[A-Za-z]{2,}/g;
const ID_KEYS = /^(payer_id|account_id|merchant_id|buyer_id|seller_id|paypal_account_id|vault_id|customer_id)$/;
const EMAIL_KEYS = /^(email_address|email|receiver|payer_email|recipient_email|buyer_email|seller_email)$/;
const NAME_STRING_KEYS = /^(given_name|surname|full_name|middle_name|alternate_full_name|recipient_name|payer_name|business_name|user_name)$/;
const TOKEN_KEYS = /(^|_)(token|access_token|id_token|nonce|ba_token|ec_token)$/i;

/** True for a key whose string value is a person's or a business's name. `parentKey` tells item names (kept) from people. */
function isPersonName(key, parentKey) {
  if (NAME_STRING_KEYS.test(key)) return true;
  return key === 'name' && /^(buyer|seller|payer|payee|recipient|sender|shipping|account|merchant)$/.test(parentKey);
}

/** A link without its query string (approval links carry `token=`). */
export function stripQuery(href) {
  if (typeof href !== 'string') return href;
  const q = href.indexOf('?');
  return q < 0 ? href : href.slice(0, q);
}

export function sanitizePayPal(value, parentKey = '') {
  if (Array.isArray(value)) return value.map((v) => sanitizePayPal(v, parentKey));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (EMAIL_KEYS.test(k) && typeof v === 'string') out[k] = 'redacted@example.com';
      else if (ID_KEYS.test(k) && typeof v === 'string') out[k] = 'REDACTEDID';
      else if (TOKEN_KEYS.test(k) && typeof v === 'string') out[k] = 'REDACTED';
      else if (k === 'name' && v && typeof v === 'object') out[k] = { full_name: 'Test Buyer' };
      else if (typeof v === 'string' && isPersonName(k, parentKey)) out[k] = 'Redacted';
      else if (k === 'address' && v && typeof v === 'object') out[k] = { country_code: typeof v.country_code === 'string' ? v.country_code : 'US' };
      else if (/phone/i.test(k)) out[k] = 'redacted';
      else if (k === 'href') out[k] = stripQuery(v);
      else out[k] = sanitizePayPal(v, k);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (EMAIL.test(value)) return 'redacted@example.com';
    return value.replace(EMAIL_ANYWHERE, 'redacted@example.com');
  }
  return value;
}

/** Strings that must never appear in a saved fixture (the caller passes the real emails and ids it knows). */
export function findLeaks(text, secrets) {
  const hits = [];
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 4 && text.toLowerCase().includes(s.toLowerCase())) hits.push(s.length);
  }
  return hits;
}
