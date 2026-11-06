<p align="center">
  <img src=".claude-plugin/icon.png" alt="autosuggest icon: a ghost with a terminal prompt" width="128" height="128">
</p>

# autosuggest

Ghost-text suggestions for Claude Code, in two places:

1. **After Claude answers**, the empty prompt box shows the message you'll most likely send
   next ("run the tests", "open a PR"), the way Codex does.
2. **While you type**, if you stop for a couple of seconds in the middle of a sentence, the
   plugin finishes the sentence for you in dim text after the cursor.

In the terminal both show up faded, like disabled text. Tab takes the suggestion, and if you
keep typing it gets out of the way. In the desktop app, which draws its own prompt box, the
next-prompt suggestion appears in a band above the box with a Send button instead.

```
> Rode os testes que você acabou de escrever             ← empty box, after a reply

> Corrige o bug no| arquivo de login                     ← while typing, after a pause
                    └──── dim, Tab to accept ────┘
```

## Where it works

| Where you run Claude Code | Next-prompt suggestion | Inline completion |
| --- | --- | --- |
| `claude` in a terminal | Dim text in the empty box, Tab to accept | Dim text after the cursor, Tab to accept |
| Desktop app, local session | Band above the box with Send and Dismiss | Not available |
| Cloud session viewed from an app | Not available | Not available |

The plugin picks the right one by itself. The reasons for the gaps are under
[Known limitations](#known-limitations).

## Install

At a Claude Code prompt:

```
/plugin install autosuggest --marketplace rcoleto/claude-autosuggest
```

Answer `y` to add the marketplace, then pick a scope. User scope turns the plugin on in every
project.

From a shell:

```bash
claude plugin install autosuggest --marketplace rcoleto/claude-autosuggest
```

In the desktop app, where `/plugin` isn't available, click **+** next to the prompt box, then
**Plugins** > **Add marketplace**, enter `rcoleto/claude-autosuggest`, and click **Add plugin**.

To update later, run `/plugin`, open the marketplace and update `autosuggest`, or reinstall with
the same command.

## Next-prompt suggestion

When Claude finishes a reply, wait a second or two and the empty prompt box fills with a dim
guess at your next message. It's written in the language you've been using and points at
things from the conversation, such as the file you were editing or the test that failed.

- Tab or → puts the text in the box, where you can edit it before sending.
- Typing anything else dismisses it.

In the desktop app the same suggestion appears in a band right above the prompt box:

```
Suggested: roda os testes que você acabou de escrever
[Send]  [Dismiss]
```

Send sends it as your next message. Dismiss hides it. The band also goes away while Claude is
working and as soon as you send a message of your own. The desktop app doesn't let a plugin put
text into its prompt box, so there's no way to edit the suggestion before sending it.

You won't get one when there's no obvious next step, after an interrupted turn or one that
ended in an error, or for subagent turns.

## Inline completion

Start typing a message and stop in the middle of it. After 2 seconds without a keystroke, the
plugin sends your draft to the model and draws the rest of the sentence after the cursor in
faint text. It can finish a half-typed word (`arqu` → `ivo`) or add the next few words, up to
about 15.

- Tab or → (with the cursor at the end) adds the completion to your draft.
- Typing the same letters the completion shows keeps the rest of it on screen, so you can
  accept it a few characters at a time.
- Typing something different removes it.

The plugin skips the completion when:

- the draft ends with a period, since that reads as a finished thought;
- the cursor isn't at the end of the draft;
- the draft is shorter than 6 characters;
- the draft is a slash command (`/compact ...`) or a shell line (`!git status`).

If you change the draft while a completion is on its way, the plugin throws that completion
away, so you never see one meant for an older version of your text.

## Commands

| Command | What it does |
| --- | --- |
| `/autosuggest` | Shows what's on and the current delay |
| `/autosuggest on` / `off` | Turns both features on or off |
| `/autosuggest next on` / `off` | Only the next-prompt suggestion |
| `/autosuggest inline on` / `off` | Only the inline completion |
| `/autosuggest delay <seconds>` | How long you have to stop typing before a completion is requested. Between 0.5 and 10, default 2 |
| `/autosuggest debug` | Shows the last steps of inline completion, for when it doesn't appear |
| `/autosuggest help` | Lists these commands |

Settings are saved and carry over to new sessions. Turning off the next-prompt suggestion brings
back Claude Code's built-in one.

## How it works

Both features use `$.model.fork`, which sends one short extra request built on the conversation
Claude Code already sent. The API reads that conversation from the prompt cache, so the plugin
doesn't pay full price for it on every call. The extra request gets no tools and is told to
answer immediately, without extended thinking.

For the next-prompt suggestion, the request runs once at the end of each turn. It asks the model
to pick the most likely next message using these rules, in order:

1. If Claude's last reply asked you something or offered options, suggest the answer you'd most
   likely give, such as approving the option Claude recommended.
2. If something failed or is still unverified, suggest what you'd most likely do about it.
3. If Claude proposed a next step, suggest asking for it.
4. Otherwise, suggest the natural next task.

The model first writes a short line saying which rule it used, then the suggestion. That small
step of reasoning makes the choice better, and you never see that line. The suggestion is written
in your style, which the model reads from your earlier messages: language, length, casing,
punctuation and how formal you are. The plugin then drops suggestions that only say "ok" or
"thanks" and ones that repeat the message you just sent, strips quotes, labels and markdown, and
passes the rest to the prompt box.

For inline completion, every edit restarts a timer. When the timer runs out, the request carries
your draft and asks only for the text that comes after it, in your style, preferring the real
names of files, functions and commands from the conversation over generic words. The plugin removes any part of the
draft the model repeated and keeps the leading space only when the model is starting a new word.
It then draws the text after your cursor with the terminal's faint style. That text is a
decoration and never becomes part of your draft until you accept it.

Nothing runs when there's nowhere to show a suggestion, such as `claude -p` or an Agent SDK
script with no app attached.

## Cost and privacy

Each next-prompt suggestion costs one request per reply. Each inline completion costs one
request per pause, and only one runs at a time. Most of what those requests send is read from
the cache, and the replies are short, so the cost is small but not zero. If you'd rather not pay
for it, turn either feature off.

Your unfinished draft goes to the same model and API account your Claude Code session already
uses. Nothing is sent anywhere else, and the plugin doesn't store drafts.

## Known limitations

- Inline completion needs Claude Code's own prompt box, which only exists when you run `claude`
  in a terminal. The desktop app and the web and mobile apps draw their own text box and only
  hand your message to Claude Code when you press Enter, so the plugin never sees what you type
  there.
- In the desktop app, Claude Code can't put ghost text in the app's box, so the next-prompt
  suggestion uses the band above it. The plugin can't fill the app's box either, which is why
  the band only offers Send and Dismiss.
- In a cloud session followed from an app, the app doesn't draw plugin UI at all, so neither
  feature shows anything. The plugin notices there's nowhere to show a suggestion and doesn't
  spend the request.
- Claude Code also doesn't draw the inline completion in screen-reader mode.
- "Dim" is the terminal's faint text style. How faint it looks depends on your terminal and
  theme. Terminals can't make text truly transparent.
- While the next-prompt suggestion is on, Claude Code's built-in suggestion is hidden so the two
  don't compete for the box. On a turn where the plugin has nothing to suggest, the box stays
  empty.

## Troubleshooting

**Nothing shows up after a reply.** Run `/autosuggest` to check that it's on. If a reply had no
clear follow-up, there's intentionally no suggestion.

**No band in the desktop app.** The band only appears in local sessions, after Claude finishes
a reply, while the prompt box is empty of your own message. Check `/autosuggest` from a terminal
session to make sure the next-prompt suggestion is on.

**Inline completion never appears.** Type a draft, wait a few seconds, then send
`/autosuggest debug`. It lists what happened, step by step: whether your typing reached the
plugin, why a draft was skipped, what the model answered, and whether Claude Code drew it. Common
reasons: the cursor isn't at the end, the draft ends with a period, or you didn't wait longer than
the delay. It only works in
Claude Code running in your own terminal: not in a cloud session viewed from an app, and not in
screen-reader mode.

**Tab doesn't accept the completion.** Use → with the cursor at the end of the draft.

**Something fails silently.** Start Claude Code with `claude --debug`; failed requests are logged
as `autosuggest: ...`.

## Development

```
.claude-plugin/
  plugin.json        the plugin manifest
  marketplace.json   makes this repository installable as a marketplace
  icon.png
hooks/
  hooks.json         points Claude Code at the hooks module
  register.tsx       all of the plugin's logic, including the desktop band
types/
  index.d.ts         the shared state the band reads
tests/
  autosuggest.test.tsx
```

```bash
claude plugin validate .
claude plugin test .
```

The tests run the plugin inside Claude Code's plugin engine with the model, the prompt box and
the clock replaced by stubs. They cover both features, the desktop band (drawn, Send, Dismiss),
every command, and the cases where a suggestion should be dropped or skipped.

To try local changes in a real session:

```bash
claude --plugin-dir .
```

## Changelog

**1.3.1**: `/autosuggest debug` shows each step of the last inline completion attempts. The
plugin now reads the prompt box before drawing a completion, so it only draws over the draft the
completion was made for.

**1.3.0**: Desktop app support. Where Claude Code can't show ghost text because the app draws
the prompt box, the next-prompt suggestion appears in a band above the box with Send and Dismiss.
The plugin only makes the request when a terminal or an app is there to show the result.

**1.2.0**: Smarter suggestions. The next-prompt suggestion answers Claude's open questions
first, follows up on failures and proposed steps, and copies your writing style. It skips bare
"ok"/"thanks" and repeats of your last message. Inline completion copies your style and prefers
names from the conversation. The README now explains that both features need Claude Code running
in your own terminal.

**1.1.0**: Inline completion of half-typed drafts after a pause, with Tab or → to accept and
partial acceptance by typing. New `/autosuggest next`, `inline`, `delay` and `help` commands.

**1.0.2**: Ghost icon.

**1.0.0**: Next-prompt suggestion in the empty box after each reply.

## License

MIT
