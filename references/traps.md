# Traps

Ways Beeper misreports or surprises, grouped by what you see. Each entry says what happens and what to do. Entries marked "seen" were reproduced while building this skill. The rest come from months of agent use.

## Contents

- A write reported an error
- Wrong person or wrong chat
- Names and numbers
- Unread and read
- Drafts
- Groups
- Delete, edit, react
- Search
- Setup and docs

## A write reported an error

- **The action may have happened anyway.** Group creation answered `500 Failed to execute tool: createChat` and the group existed seconds later. Seen on iMessage. Reported on LinkedIn as a 404. Read the chat list before anything else. `ba group` looks for a group with exactly those members before and after the call.
- **The CLI repeats failed requests.** Its built-in SDK sends a request again when the server answers with an error. Seen: one create call with a first message sent that message three times. `ba send` and `ba group` make a single request for this reason. Sending or creating through the raw `beeper` CLI carries this risk.
- **`beeper send text --wait` fails on iMessage.** It answers "Timed out waiting for … 404 Message not found" after the message went out. Seen twice.
- **"In the chat" is not "delivered".** A message a network rejected can still be listed. Say "sent", and never "delivered" or "seen".
- **A broken send is not permission to switch channels.** When iMessage fails, do not send the same text over WhatsApp. Tell the Owner.

## Wrong person or wrong chat

- **The CLI matches loosely.** `--chat` and `--to` accept titles and search text. A search for one first name returned chats with unrelated people and network bots. Seen. Pass the full chat id and nothing else.
- **One person has several chats.** One per network, and sometimes an old thread under a previous number. `ba find` lists them all with the last activity.
- **Sharing a group is not a chat.** `ba find` hides groups a person only belongs to. Add `--all` to see them.
- **Verify before writing.** Check the network, the members, and the last few messages against what the Owner expects.

## Names and numbers

- **iMessage gives numbers only.** Chat titles and member names arrive as phone numbers. `ba` looks them up in the Mac's Contacts.
- **A number shared by two contacts stays a number.** `ba find` names both owners. Ask the Owner which.
- **iMessage is missing from `beeper accounts`.** The chats still list and send. Do not conclude iMessage is disconnected.
- **Contacts not readable.** Chats show numbers and `ba check` warns. The terminal app needs Full Disk Access.
- **Contact creation needs a second permission.** The first `ba contact` opens a system prompt asking to control Contacts. It waits until the Owner answers.
- **Group senders can arrive as network ids.** `ba` prints "someone" when it cannot name them.

## Unread and read

- **Unread can outlive the Owner's reply.** The row is marked `LAST-IS-MINE`. It usually needs a mark as read and no reply.
- **Read chats vanish from unread-only scans.** That is how replies get dropped, and why triage includes READ rows.
- **Replying from a phone may not clear unread in Beeper.** Check the state and do not assume.
- **Beeper's unread filter returns stale rows.** One fetch held 54 rows and 11 were unread. `ba` checks the count on each chat and ignores the filter.
- **The latest item is often not a message.** It can be a tapback, an unsent notice, a blank attachment row, or a system event. Seen in about one chat in eight. `ba` flags these rows, so do not treat them as something owed.
- **Pinned is not muted.** Pinned chats matter more. Muted, archived, and low-priority chats are the ones left out.

## Drafts

- **One draft per chat.** Saving a new one replaces what the Owner was typing. `ba draft` refuses unless told `--replace`.
- **Beeper stores drafts as HTML.** A draft reads back as `<p>text</p>` with `&amp;` style codes. Seen. `ba` converts it, and the raw CLI does not.
- **Beeper only accepts a draft when the box is empty.** `ba draft --replace` clears first.
- **Saved is not sent.** Say "saved in Beeper".
- **Drafts follow the account, except on iMessage.** A saved draft shows up in Beeper on the Owner's other devices. Seen on Instagram, X, WhatsApp, and LinkedIn. An iMessage draft stays on the Mac that saved it, and an iPhone shows none, because iMessage there lives in Apple's Messages app.
- **The synced copy lags by about half a minute.** Checking sooner finds nothing. Seen.

## Groups

- **iMessage wants phone numbers or emails for members.** The member ids Beeper shows for iMessage people are rejected with a 500. Seen.
- **Never put the first message inside the create call.** See the repeat problem above. Create, verify, read the chat, then send.
- **iMessage ignores the group name.** The name given at creation was dropped and a rename did not show. Seen.
- **LinkedIn can insert a placeholder.** A new group there may already hold a message reading "New chat". Read before sending, and ask before deleting it.
- **`beeper chats start` fails on iMessage.** It answers `UNSUPPORTED_IDENTIFIER`. Find the existing chat with `ba find`. For someone with no chat yet, the Owner starts it in Messages.
- **Same members, same group.** On iMessage, creating a group with the same people returns the existing one.

## Delete, edit, react

- **iMessage unsends for about two minutes.** After that the delete fails with a 500. Seen.
- **An unsent message leaves a mark.** The other side sees that something was unsent. The chat lists it as "unsent a message".
- **Deleting on one side only fails on iMessage.** Seen.
- **Edits are visible.** Most networks show that a message was edited.
- **Reactions arrive as messages.** Tapbacks read like `Loved "…"` and others like `You reacted to "…"`. Rows marked `REACTION` need no reply.
- **React to the message the Owner saw.** Use the reference from `ba chat`. Counting from the end of a list picks the wrong one, because lists arrive newest first.

## Search

- **Message search matches words, not meaning.** Try two or three likely keywords.
- **The search parameter is `query`.** An unknown parameter such as `q` is ignored and recent chats come back, which looks like a wrong answer.
- **Search is slow right after Beeper starts.** It is still indexing. Recent chats list fine.
- **Message search refuses a limit above 20.** It answers with a 400 error.
- **Archived chats are missing from the default list.** `ba find` can miss a person whose only chat is archived. Check with `beeper chats list --archived --read-only`.
- **Paging can repeat.** The CLI's `--before-cursor` has returned the same page twice. Stop when a page brings nothing new.
- **History can be partial.** Chats joined recently may hold only recent messages. "Nothing found" does not prove nothing was said.

## Setup and docs

- **`beeper doctor` can say "initializing" while everything works.** Seen. `ba check` does a real read and is the one to trust.
- **Skip Beeper's MCP server for this job.** It has no draft or mark-read tools, and search calls through it have hung.
- **Do not fetch Beeper's `llms-full.txt`.** It is about 19,000 tokens and mostly covers Android. `beeper <command> --help` is shorter and matches the installed version.
- **Raw API calls need care.** Chat ids contain `#`, `:` and `!`, so encode them in a URL. Filter by account with one `accountIDs` parameter per account. A comma-joined list returns nothing and no error.
- **A 403 on send can be a setting.** Tokens made by hand in Beeper's settings need "Allow sensitive actions" turned on. Reported, and not seen with the CLI's own login.
- **Pace your sends.** Beeper's docs warn that networks can suspend accounts that send too much. One chat at a time, and never a bulk send.
