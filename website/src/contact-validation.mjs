export const needTypes = ["ai", "decision", "team", "advice", "global", "demo", "other"];
export function validateInquiry(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, field: "form" };
  const bounds = { name: [1, 80], company: [1, 160], email: [3, 254], industry: [1, 100], message: [10, 3000] };
  const value = {};
  for (const [field, [min, max]] of Object.entries(bounds)) {
    if (typeof input[field] !== "string") return { ok: false, field };
    const text = input[field].trim();
    if (text.length < min || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return { ok: false, field };
    if (field !== "message" && /[\r\n]/.test(text)) return { ok: false, field };
    value[field] = text;
  }
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.email)) return { ok: false, field: "email" };
  if (!needTypes.includes(input.need)) return { ok: false, field: "need" };
  if (input.consent !== true) return { ok: false, field: "consent" };
  if (!["zh", "en"].includes(input.locale)) return { ok: false, field: "locale" };
  if (typeof input.website !== "string" || input.website.length > 0) return { ok: false, field: "website" };
  return { ok: true, value: { ...value, need: input.need, locale: input.locale, consent: true } };
}
