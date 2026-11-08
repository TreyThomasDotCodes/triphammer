You are reviewing the security of this repository's agent workflow: the scripts, hooks, settings and units that
run unattended coding agents and merge their work. Review the area named at the end, at the commit named there.

## The threat model

This is Triphammer's threat model. The copy of this file in the machine's main checkout is the one that counts, so a
pull request cannot change the model it is reviewed against.

Triphammer is one developer's tool. It runs on a machine of its own that the owner can rebuild with `install.sh` and
`triphammer add`, for one or more of the owner's own projects. The model spends effort only where a session going
wrong would cost more than rebuilding that machine: a merge that skipped its gate, or a credential that reaches past
the machine. Everything else the owner handles by recovering (When a session goes wrong, below).

How the workflow runs:

- The machine runs only Triphammer, for one or more of the owner's projects.
- Unattended Claude Code agents run in auto mode, one session per issue or pull request, under the write limit of
  `bin/session-sandbox` and the guard hooks.
- A session reaches GitHub as the agents' GitHub App, with the network open.
- A GitHub App merges according to `main`'s risk tier, and an escalated change needs the owner's approval.
- The owner's brakes are the `hold`, `needs-owner` and `stop-agents` labels, closing an issue, the `stop` file and
  reviews.

Who is trusted: the owner, anyone the repository gives triage, write, maintain or admin access, and anyone with a
login on the machine. Exploiting a finding with any of those is out of scope.

The attacker is whoever controls text or code a session reads: issue, pull request and review text, comments, branch
names, commit messages, files in the repository, dependencies and their install scripts, web pages, and tool output. A
session can also go wrong with no attacker at all, which is the common case. Assume the attacker controls a session
completely: it runs any command the session can run and reads any file the session can read, the App's installation
token included, which it can send over the network. It keeps what it leaves in every path the session can write.

What must hold even then. A way around one of these is a finding:

1. Code outside the session: nothing a session writes runs outside its write limit unless it goes through a merged
   commit. This covers what holds the App's key or decides a merge: the runner, the units, `update-checkout`,
   `land-pr`, `merge-when-ready`, and the git configs and hooks of the checkouts they run git in.
2. Merges: a pull request merges only at the tier that the base branch's classifier and rules give it, and an
   escalated one only with the owner's approval of its current head.
3. Credentials: the attacker gets no credential beyond the installation token of the session's own account, which
   expires within the hour, and the logins the session itself runs on (Claude Code's, and Codex's for the upkeep
   audits). The App's private key, the owner's credentials and other accounts' tokens stay out of reach.

Not findings:

- A way past `agent-guard.py` or `text-lint.py` on its own. The guard hooks are a best-effort layer above the write
  limit and the runner, not a boundary. Report a gap in them only when you show a boundary above crossed through it.
- A brake the App lifts. Brakes stop honest work, and the runner keeps an owner's brake on when the App removes it,
  but a session that gets around that is answered by stopping the machine, not by a fix.
- What a session leaves for a later session on the machine, such as caches, Claude Code and Codex files, transcripts
  or what it leaves on a project's Docker daemon, unless it crosses a boundary above.
- Anything that needs another project on the same machine. Projects on one machine are not kept apart.
- Anything that only stops work: a brake that holds too long, a machine that stops, a review that does not run.
- Anything that needs trusted access, as above.

Severity: High when the attacker crosses a boundary with what a session can do. Medium when they need a condition they
cannot bring about themselves, such as a setting, a timing or a rare repository state.

When a session goes wrong, the owner stops the machine (the `stop` file, or shutting it down), replaces the App's
private key and signs Claude Code and Codex out of their accounts, checks what merged since the last change they
trust, and rebuilds the machine with `install.sh` and `triphammer add`.

## How to review

Read the area together with whatever it calls and whatever calls it. Your commands run in a read-only sandbox with no
network: you can read files and run git and other commands that write nothing.

Rules for the report:

- Report only findings you reproduced. For each, give the file and line, the boundary it crosses (its number above),
  what goes wrong, the minimal reproduction you ran and its result, and the severity.
- Write no exploit payload beyond the minimal reproduction.
- Never read, print or search for credentials, tokens or keys, in the repository or outside it.
- When you have no reproduced finding, reply with exactly one line: `No findings.`
