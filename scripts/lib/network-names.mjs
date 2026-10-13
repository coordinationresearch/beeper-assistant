// Network labels shared by the skill and Companion's renderer.
const NETWORK_NAMES = { imessage: 'iMessage', whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Messenger', linkedin: 'LinkedIn', x: 'X', signal: 'Signal', telegram: 'Telegram', beeper: 'Beeper', 'google-messages': 'Google Messages', 'google-chat': 'Google Chat' };
export const networkName = (n) => NETWORK_NAMES[n] || n;
