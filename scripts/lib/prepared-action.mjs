// The visible specification is the execution specification. No hidden command or provider payload.
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
export function preparedActionBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = ['chatID', 'after', 'subject', 'title', 'description', 'button'];
  if (Object.keys(value).length !== fields.length || !fields.every(key => Object.hasOwn(value, key))) return null;
  if (!text(value.chatID, 2048) || !/^(imsg##|!)/.test(value.chatID) || /\s/.test(value.chatID)
    || !text(value.after, 2048) || /\s/.test(value.after) || !text(value.subject, 2048)
    || !text(value.title, 100) || /[\r\n]/.test(value.title) || !text(value.description, 1400)
    || !text(value.button, 40) || /[\r\n]/.test(value.button)) return null;
  return { chatID: value.chatID, after: value.after, subject: value.subject, title: value.title, description: value.description, button: value.button };
}
export const actionCard = body => `${body.title}\n${body.description}\nAction: ${body.button}`;
export const actionID = value => typeof value === 'string' && /^a[0-9a-f]{8}$/.test(value);
