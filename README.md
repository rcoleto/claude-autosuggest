<p align="center">
  <img src=".claude-plugin/icon.png" alt="autosuggest icon: a ghost with a terminal prompt" width="128" height="128">
</p>

# autosuggest

Ghost-text suggestions for Claude Code, in two places:

1. **After Claude answers**, the empty prompt box shows the message you'll most likely send
   next ("run the tests", "open a PR"), the way Codex does.
2. **While you type**, if you stop for a couple of seconds in the middle of a sentence, the
   plugin finishes the sentence for you in dim text after the cursor.

Both show up faded, like disabled text. Tab takes the suggestion. If you keep typing, it
gets out of the way.

```
> Rode os testes que você acabou de escrever             ← empty box, after a reply

> Corrige o bug no| arquivo de login                     ← while typing, after a pause
                    └──── dim, Tab to accept ────┘
```

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
| `/autosuggest help` | Lists these commands |

Settings are saved and carry over to new sessions. Turning off the next-prompt suggestion brings
back Claude Code's built-in one.

## How it works

Both features use `$.model.fork`, which sends one short extra request built on the conversation
Claude Code already sent. The API reads that conversation from the prompt cache, so the plugin
doesn't pay full price for it on every call. The extra request gets no tools and is told to
answer immediately, without extended thinking.

For the next-prompt suggestion, the request runs once at the end of each turn and asks for the
single message you're most likely to send, under 30 words. The plugin strips quotes, labels such
as `User:` and markdown from the reply, then passes it to the prompt box.

For inline completion, every edit restarts a timer. When the timer runs out, the request carries
your draft and asks only for the text that comes after it. The plugin removes any part of the
draft the model repeated and keeps the leading space only when the model is starting a new word.
It then draws the text after your cursor with the terminal's faint style. That text is a
decoration and never becomes part of your draft until you accept it.

Neither feature runs in headless mode (`claude -p`, the Agent SDK), since there's no prompt box
there to show anything in.

## Cost and privacy

Each next-prompt suggestion costs one request per reply. Each inline completion costs one
request per pause, and only one runs at a time. Most of what those requests send is read from
the cache, and the replies are short, so the cost is small but not zero. If you'd rather not pay
for it, turn either feature off.

Your unfinished draft goes to the same model and API account your Claude Code session already
uses. Nothing is sent anywhere else, and the plugin doesn't store drafts.

## Known limitations

- The inline completion is drawn by the terminal's prompt box. Claude Code doesn't draw these
  decorations in sessions shown on a remote host (for example a cloud session followed from the
  web or mobile app) or in screen-reader mode, so you won't see inline completions there. The
  next-prompt suggestion isn't affected.
- "Dim" is the terminal's faint text style. How faint it looks depends on your terminal and
  theme. Terminals can't make text truly transparent.
- While the next-prompt suggestion is on, Claude Code's built-in suggestion is hidden so the two
  don't compete for the box. On a turn where the plugin has nothing to suggest, the box stays
  empty.

## Troubleshooting

**Nothing shows up after a reply.** Run `/autosuggest` to check that it's on. If a reply had no
clear follow-up, there's intentionally no suggestion.

**Inline completion never appears.** Check that the cursor is at the end, the draft doesn't end
with a period, and you waited longer than the delay (`/autosuggest` shows it). In a remote or
screen-reader session the decoration isn't drawn at all.

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
  register.ts        all of the plugin's logic
tests/
  autosuggest.test.ts
```

```bash
claude plugin validate .
claude plugin test .
```

The tests run the plugin inside Claude Code's plugin engine with the model, the prompt box and
the clock replaced by stubs. They cover both features, every command, and the cases where a
suggestion should be dropped or skipped.

To try local changes in a real session:

```bash
claude --plugin-dir .
```

## Changelog

**1.1.0**: Inline completion of half-typed drafts after a pause, with Tab or → to accept and
partial acceptance by typing. New `/autosuggest next`, `inline`, `delay` and `help` commands.

**1.0.2**: Ghost icon.

**1.0.0**: Next-prompt suggestion in the empty box after each reply.

## License

MIT
