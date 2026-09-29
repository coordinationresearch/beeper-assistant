# Setting up beeper-assistant for someone

You are an agent, and the person you work for asked you to set up this skill. This file is the whole procedure. It is short: get the skill, run the installer, and fix whatever its check reports.

The skill lets you read their chats through Beeper, tell them who is waiting on a reply, and save drafts. Their messages are private. Setup shows you no message text and changes nothing in Beeper.

## Steps

1. **Get the skill.**

   ```bash
   git clone https://github.com/coordinationresearch/beeper-assistant ~/.local/share/beeper-assistant
   ```

   If that folder already exists, run `git -C ~/.local/share/beeper-assistant pull`.

   If `git` is missing, macOS opens a window offering to install developer tools. Only the person can accept it. Ask them to, then run the command again.

2. **Run the installer.**

   ```bash
   ~/.local/share/beeper-assistant/install.sh
   ```

   It copies the skill to each agent on this Mac, then checks the setup. Every line of the check starts with `ok`, `warn`, or `FAIL`.

3. **Fix each `FAIL`, one at a time.** Each one prints its own fix. After a fix, run the check again with the command on the installer's last line.

   | Line | You or the person | What to do |
   |---|---|---|
   | `This is … The skill needs a Mac` | | Stop. Tell the person the skill is Mac only |
   | `Node not found` or `too old` | You | Say you are installing Node, then `brew install node` |
   | `Beeper Desktop is not installed` | The person | They install it from https://www.beeper.com, sign in, and connect their chat apps. Wait until they say it is done |
   | `Beeper command line tool is not installed` | You | Say you are installing it, then `brew install beeper/tap/cli` |
   | `brew: command not found` | The person | They install Homebrew from https://brew.sh. It asks for their password |
   | `Beeper does not answer` | Both | The person opens Beeper Desktop and signs in. Then run `beeper setup`. See the note below |
   | `Cannot write state` | You | Read the message. It names the folder |

   **About `beeper setup`.** It can stop and wait for an answer or an approval on another device. Run it with a time limit of one minute. If it has not finished, stop it, and ask the person to run `beeper setup` in their own terminal and tell you when it is done.

4. **Handle `warn`.** `Contacts not readable` means iMessage chats show phone numbers where names should be. The skill works without it. Tell the person what fixes it, that it is optional, and what it grants: Full Disk Access lets the app you run in read every file on their Mac. Let them decide.

5. **Offer read-only mode.** Ask the person: "Do you want to start in read-only mode? In that mode I can read and list, and I cannot save drafts or send." If yes, run the `mode readonly` command:

   ```bash
   node ~/.local/share/beeper-assistant/scripts/ba.mjs mode readonly
   ```

   Only the person can loosen the mode later. The command tells them how.

6. **Hand over.** Tell the person, in a few lines:
   - the skill is installed, and for which agents
   - anything still marked `warn`, and what it costs them
   - the mode it is in, and what that allows
   - in full mode: it saves drafts and marks chats read without asking, and it asks before it sends anything

7. **First use.** A new skill loads when a session starts. If you cannot see `beeper-assistant` among your skills, read the installed `SKILL.md` and follow it. The installer printed where it is. The first thing to run is triage, which only reads.

## Rules

- **Change nothing in Beeper during setup.** No drafts, no sends, no marking read.
- **Do not edit the skill's files.** The installed copy is read-only on purpose.
- **Do not print tokens.** `beeper status` shows an access token. Never show it to the person or write it anywhere.
- **Say what you install before you install it.**
- **If a step fails twice, stop.** Tell the person what you ran and what it printed.
