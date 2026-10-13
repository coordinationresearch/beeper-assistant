# Coordination

A Coordination is one goal the Owner reaches with several people, each in their own one-to-one Chat (DM), such as finding a night everyone can do dinner or asking each person what they're bringing. It runs in Rounds. A Round is one message to each person, which goes out only after the Owner says yes to the exact list, and each message goes near the hour that person usually talks, never at night. Read this before you message several people for one goal.

## What starts one

- **The Owner asks for a goal with several people by DM,** such as "find a night next week for dinner with Ana, Ben and Cal" or "ask everyone what they're bringing on Saturday". Pick the obvious People and say which.
- **The Owner asks for the next step of a Coordination,** even a message to one of its people, such as "ask Cal if Thursday works". That is a later Round.
- **Not a Coordination:** a message the Owner dictates to several people, such as "tell Ana and Ben I'm running late". Send each their own message, as any send.
- **Not a Coordination:** a group Chat they're all in. Write there instead, unless the Owner wants each asked on their own.

When the Owner gives the same goal to Auto in several DMs, or sets a goal in a DM whose person shares a group Chat with another DM that has one, offer to run them as one Coordination instead. On their yes, write the Round.

## Picking the People and their DMs

1. Run `ba find --json` for each person and pick their one-to-one Chat on the network the Owner uses with them most lately. `ba app` commands take its exact Chat ID, starting with `!` or `imsg##`, never a short `c…` reference. When a name matches more than one person and none is obvious, ask which.
2. A first Round goes to 2 to 8 people.
3. A DM that is already in another active Coordination belongs to that one. `ba app coordinations` lists them. Offer to run this goal there, or to end that one first.

## Writing a Round

Write each person their own message, in the Owner's Voice for that Chat: run `ba app voice <chatID>` for each. Keep each short, and ask one clear thing. Read the moves and this Owner's Lessons first: `ba playbook "Rallying a group"`. When the Owner rewrites a Round's message or turns the list down, save what it showed: `ba learn "Rallying a group" --text "<what to do for this Owner>" --why "<what happened, in a few words>" --by <your name>`.

A first Round says nothing one person told the Owner about another. A later Round may use what people said in their own DMs, such as "Ben can only do Thursday", because the Owner reads the list before it goes. Name who said it, never lead with bad news, and leave out anything that sounds private.

## Saving the card

Save the Round: `ba app round prepare --goal "<the goal, in a few words>" --to <chatID> --text "<message>" --to <chatID> --text "<message>"`, one `--to` and its `--text` per person, in the order they should go. It sends nothing. It prints the card's text: the goal, then each person with their network and Handle, the window their message goes in, and the message itself. Show the Owner the card's text word for word, as a quote, then one line on what they can say: "send" to send it, or what to change. Then stop.

Stop even when the Owner said "and send it". A Round goes to several people at once, so the Owner sees the exact list first (ADR 0094). A later answer that says yes sends it.

When `ba` refuses, say why in plain words. It refuses a group, the same person twice, a message with a blank, and a DM another Coordination holds.

On the Line, a card counts as shown only if the Line sent it whole, and the Line cuts long answers. Keep the whole answer under 600 characters: the card's text and one line on what to say. Check the length of the card `ba` printed. When it won't fit, shorten the messages and save again, or say the list is too long for the Line and to ask in the sidebar.

## The Owner's answer

- **Yes to the card** ("send", "yes", "go"): run `ba app round make <roundID>` in this turn, once. Report what it printed: who gets what, and when each message goes. Name anyone whose window had already passed, since they get nothing. Never run it a second time.
- **A change** ("drop Cal", "make Ben's shorter"): save the list again with the change, show the new card, and stop. The new card replaces the old one.
- **No, or not now:** drop it.

`ba app round make` refuses a card no answer here showed before the Owner's yes, one already sent, and one a newer list replaced. Report the refusal, and never send the messages another way. When it says the card wasn't shown here, save the list again in this turn, show the new card, and stop: an old card shown again still can't be sent.

## While it runs

Each message waits for its window. It stops on its own if that person writes first, or the Owner starts typing in that Chat. A message that can't go in its window doesn't go, and the Owner hears that from the app.

Auto is not turned on in those DMs. The Owner answers replies there, or turns Auto on in a DM if they want. Where Auto is already on, it keeps answering, and it holds off restarting a quiet conversation there while the Coordination lasts, but a check-in it already planned can still send. When one of the DMs has Auto on, say so with the card.

"How's dinner going?" is a read. Run `ba app coordinations`, then read each DM with `ba chat <chat>`, never `ba read`, which marks the Owner's Chats read. Answer person by person: whether their message went, and what they said back, in a few words each.

## The next Round

When the answers are in, offer the next Round, such as "Thursday works for Ana and Ben. Ask Cal about Thursday?". Save it with `--coordination <coordinationID>` and some or all of the same People. A later Round may carry what the others said, as above. Adding someone new is a new Coordination.

## Ending

- **The goal is reached** ("we're set", "done"): `ba app coordination end <coordinationID> --reached`.
- **The Owner stops it** ("stop", "cancel the dinner thing"): `ba app coordination end <coordinationID>`, or `all`. Every message still waiting stops.
- **Three quiet days,** with nobody writing in any of its DMs, end it on their own.
