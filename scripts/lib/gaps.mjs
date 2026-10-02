// The blank marker: a lone underscore where the Owner must fill something in, as in
// `I land _ and could do dinner`. Underscores inside words (snake_case, _italics_) are not
// blanks. The older [[…]] marker still counts. The skill's send and the companion's Send
// both refuse text that holds one.
export const GAP = /(?<![\p{L}\p{N}_])_+(?![\p{L}\p{N}_])|\[\[[^\]]*\]\]/gu;
export const gapsIn = (text) => String(text || '').match(GAP) || [];

// A copy without the g flag, so test() keeps no position between calls.
const ONE = new RegExp(GAP.source, 'u');
export const hasGap = (text) => ONE.test(String(text || ''));
