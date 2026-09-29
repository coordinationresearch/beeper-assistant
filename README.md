# beeper-assistant

Ask your AI agent what needs your reply, across every chat app you use.

It is a skill for agents such as Claude Code, Codex, and Hermes. It reads your chats through [Beeper](https://www.beeper.com) on your own Mac, tells you who is waiting on you, and saves draft replies into Beeper for you to send. That covers iMessage, WhatsApp, Instagram, LinkedIn, X, Signal, Telegram, and anything else Beeper connects.

```
You     what needs my reply?

Agent   6 people are waiting on you.

        1. Ana Flores · iMessage · 2 days · asks which days you are in town     reply
        2. Ben Okafor · WhatsApp · 5 hours · wants to move Thursday to Friday   reply
        3. Priya Nair · LinkedIn · 3 days · asks for an intro you offered       reply
        4. Sam Reed · iMessage · 1 day · sent photos from the weekend           react

        2 more are waiting.
        7 I am unsure about. All are first messages from people you never wrote to.
        5 unread chats need nothing. Want me to mark them read?
        Not shown: 9 automated senders, 4 that end in a thanks, 40 waiting on the other person.

You     draft a reply to Ben saying Friday works, same time

Agent   Saved in Beeper, in your chat with Ben. Nothing was sent.
```

The names above are made up.

## Set it up

You need a Mac. Setup takes about five minutes if you already use Beeper. If you are new to Beeper, allow more, since connecting each chat app takes a few minutes.

### The short way

Paste this to your agent:

> Set up the beeper-assistant skill from https://github.com/coordinationresearch/beeper-assistant by following the SETUP.md file in that repo. Then tell me what needs my reply.

Your agent does the installing. It stops and asks you for the things only you can do, such as signing into Beeper. If words like Homebrew and Node mean nothing to you, this is the way to go.

### By hand

1. **Beeper Desktop.** Install it from [beeper.com](https://www.beeper.com), sign in, and connect the chat apps you use.
2. **The Beeper command line tool.**

   ```bash
   brew install beeper/tap/cli
   beeper setup
   ```

3. **The skill.**

   ```bash
   git clone https://github.com/coordinationresearch/beeper-assistant ~/.local/share/beeper-assistant
   ~/.local/share/beeper-assistant/install.sh
   ```

   The installer copies the skill to each agent it finds and then checks the setup. Every line of the check should start with `ok`. For any line that starts with `FAIL`, it prints the fix.

4. **Names for iMessage.** Optional. iMessage chats show phone numbers until the app your agent runs in has Full Disk Access, under System Settings, Privacy & Security. With it, they show names from your Contacts. Be aware of what you are granting: Full Disk Access lets that app read every file on your Mac. The skill works without it.

5. **Start a new session in your agent and ask:** "what needs my reply?"

It needs git, Homebrew, and Node 18 or newer. The installer's check names anything that is missing.

## Things to ask

| You say | It does |
|---|---|
| "what needs my reply?" | Lists who is waiting on you, including chats you read and never answered |
| "find my chats with Sam" | Shows every chat with that person, on every app |
| "draft a reply to Sam" | Reads the chat and saves a draft in Beeper's compose box |
| "send it" | Shows you the exact text and chat, waits for your yes, then sends once |
| "who is this number?" | Reads the chat, offers a guess, and adds a contact when you agree |
| "mark the ones that need nothing as read" | Clears them |

It can also react, edit, unsend, set reminders, and start groups.

## Your messages and your privacy

- **It runs on your Mac.** There is no server and no account, and it collects nothing.
- **Your agent reads the messages it works with.** That text goes to whichever AI model your agent uses, the same as anything else you show your agent. If you would not paste a chat into your agent, do not ask the skill about it.
- **How much it reads.** "What needs my reply?" gives your agent one line per waiting chat: the name, the app, and the last message or few. On a busy account that is a few pages of text. Opening one chat gives it the last 20 messages of that chat.
- **It keeps one small file,** at `~/.config/beeper-assistant/state.json`. It holds chat ids: a lookup table for the short references the skill uses, and the chats you dismissed or had drafted. It stores no names and no message text.
- **Messages from other people are treated as untrusted.** The skill marks them and tells your agent to never follow instructions inside them. That lowers the risk of a message tricking your agent. It does not remove it.
- **Beeper is a separate product,** with its own account, pricing, and privacy terms. The skill only sees chats you have connected to Beeper.

## What it changes

| Without asking | Only after your yes |
|---|---|
| Saves drafts | Sends a message |
| Marks a chat read | Reacts, edits, or unsends |
| Sets a reminder | Starts a chat or a group |
| | Adds a contact |

One yes covers one message to one chat. It never archives.

You can narrow this further. Set one of these before starting your agent, or write the word into `~/.config/beeper-assistant/mode`:

```bash
export BEEPER_ASSISTANT_MODE=readonly   # read only
export BEEPER_ASSISTANT_MODE=drafts     # read and save drafts
```

Read-only is a good way to try it for the first time. Your agent can switch it on for you: ask it to "start in read-only mode". Loosening a mode is left to you, by editing or deleting that file.

## Drafts on a schedule

Point a scheduler at your agent and ask it to follow `references/unattended.md`. Each run drafts replies for a few people you have written to before, puts them straight into Beeper, and stays silent unless something is urgent. A scheduled run can never send.

Drafts show up in Beeper on your other devices, on every app except iMessage. iMessage drafts stay on the Mac that saved them.

## Limits

- **Mac only.** Names and contacts depend on the Mac's Contacts.
- **It knows a question from a "thanks". It does not know who matters to you.** On a busy account, expect some rows that need nothing.
- **Your yes is a rule the agent follows, not a lock.** The skill tells the agent to get your yes before sending. The two modes above block sending in code. Neither would stop an agent that has been tricked and has full access to your Mac, so use an agent you trust.
- **It is new.** It has been tested on a small number of Macs. Beeper has quirks, and `references/traps.md` lists the ones found so far.

## Update or remove

```bash
cd ~/.local/share/beeper-assistant
git pull && ./install.sh      # update
./install.sh --remove         # remove
rm -rf ~/.config/beeper-assistant   # forget dismissed chats
```

The installed copy is read-only on purpose. Some agents rewrite their own skills after a session, and a read-only copy stays the way it shipped.

## Problems and ideas

Open an issue on this repo. Say which agent you use and paste the output of the check command. Leave out names and message text.

## For people changing the skill

```bash
node --test tests/*.test.mjs
```

The tests use made-up data and a fake Beeper path, so they never touch a real account. `evals/cases.md` lists the end-to-end cases to run by hand in an agent.

`SKILL.md` is what the agent reads. The logic lives in `scripts/lib` as plain JavaScript modules with no dependencies, so an app can import it.

When the skill gets something wrong, fix a script and add a test. Add a line to `references/traps.md` only when code cannot prevent the problem.

## Who made this

[Coordination Research](https://coordination.sh). It is the first piece of a personal agent we are building, shared early with friends.

## License

MIT. This project is not affiliated with Beeper.
