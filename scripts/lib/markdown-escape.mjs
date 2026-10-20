// Beeper's local API reads message and Draft text as Markdown and turns it into rich text (POST
// /v1/chats/{chatID}/messages, with or without a file, and the draft in PATCH /v1/chats/{chatID}).
// Networks without formatting, iMessage and SMS among them, get that rich text flattened back to
// plain text, so "- " and "1. " lines arrive as paragraphs without their marks, "*really*" as
// "really", and a link as its label alone (2026-10-20). escapeMarkdown returns the text Beeper's
// reading turns back into exactly the words given, so a send arrives as typed on every network.
// Edits (PUT) and a new Chat's first message go to the network unread, so they take the text as is.
//
// Beeper's reading (Beeper Desktop 4.x, API 5.0.0): marked 13 with GFM and hard line breaks, a
// spoiler mark "||", custom emoji "#[name](mxc://…)", raw HTML shown as text, and a text that is one
// JSON string taken as HTML. Its plain text keeps line breaks, keeps at most one blank line in a
// row, and trims the ends. apps/beeper-companion/tests/markdown-escape.test.ts runs that reading.
//
// What it escapes, with Markdown's own backslash, which Beeper consumes:
//   - anywhere: \ ` * ~ [ ] |, an _ not inside a word, a < that could open a tag or a link in
//     angle brackets, and an & that could start a character reference;
//   - at a line's start: - + * # > = and the . or ) after a number, which start lists, headings,
//     quotes, and rules, and the : of a table's divider row;
//   - spaces and tabs at a line's start, as character references, since Markdown drops them or
//     reads the line as code. Spaces before a line break get a backslash break, which keeps them;
//   - a leading ", so the text is never one JSON string.
// Everything else passes as is, so a text with none of these goes unchanged.

const INLINE = /[\\`*~[\]|]/g;
// A run of _ between letters or digits stays: Markdown never reads one inside a word, and an
// escaped one would cut an email address's link short.
const word = (char) => /[A-Za-z0-9]/.test(char ?? '');
const underscores = (line) => line.replace(/_+/g, (run, at) => word(line[at - 1]) && word(line[at + run.length]) ? run : run.replace(/_/g, '\\_'));
// A tag, a comment, a link in angle brackets, or an email address in them. "<3" stays.
const TAG = /<(?=[A-Za-z/!?]|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@)/g;
const ENTITY = /&(?=#?[A-Za-z0-9]+;)/g;
const LINE_MARK = /^[-+*#>=]/;
const NUMBERED = /^(\d{1,9})([.)])/;
// A table's divider row, such as ":--", once its pipes and leading dashes are escaped.
const DIVIDER = /^:(?=[-: \t]*-[-: \t]*$)/;
const space = (run) => run.replace(/ /g, '&#32;').replace(/\t/g, '&#9;');

export function escapeMarkdown(text) {
  // Beeper reads a lone CR as a line break, so the escape does too.
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const escaped = lines.map((line, i) => {
    const lead = /^[ \t]*/.exec(line)[0];
    if (lead === line) return space(line);
    let rest = underscores(line.slice(lead.length).replace(INLINE, '\\$&')).replace(TAG, '\\<').replace(ENTITY, '\\&');
    rest = rest.replace(NUMBERED, '$1\\$2').replace(LINE_MARK, '\\$&').replace(DIVIDER, '\\:');
    // A line break drops the spaces before it. A backslash break after them keeps them, unless a
    // blank line follows, where a backslash would show.
    const next = lines[i + 1];
    if (/[ \t]$/.test(rest) && next !== undefined && next !== '') rest += '\\';
    return space(lead) + rest;
  }).join('\n');
  // JSON allows blank lines before the string.
  return escaped.replace(/^(\n*)"/, '$1\\"');
}
