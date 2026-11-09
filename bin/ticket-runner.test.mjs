import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {exampleProject, git, here, lines, listenUnix, manyLabels, projectJson, realCommand, run, runClone, runnerSetup, withUmask, writeConfig} from './fixture.mjs';

const repo = 'Example-Owner/example-project';
// The issues' author, in the shape `gh issue list --json author` returns for the App.
const author = {is_bot: true, login: 'app/example-agents'};
const issue = (number, {state = 'OPEN', labels = []} = {}) =>
  ({number, state, author, body: '', labels: labels.map(name => ({name}))});

// A machine whose origin/main can run a ticket: the ticket-run skill, this branch's hook and publish-demos, a fake
// demo-publish that records each publish in $DEMO_CALLS and each reindex in reindex-calls (and fails a publish when
// $DEMO_FAIL is set), and a fake
// security-review that records its arguments in security-calls, copies the runner's `current` file, says whether the session had run, and fails when
// $SECURITY_FAIL is set. The fake `gh`
// offers the issues given (issue #7 by default) and the open pull requests in pulls.json (none until a session opens
// one), answers `issue create` with issue #90, and reports no stop-agents issue and no progress. The fake `claude`
// session records $TRIPHAMMER_PROPOSALS, appends proposals.jsonl, if any, to that file and removes it when
// no-proposals exists, copies the runner's `current` file and the lock file and start time of the process it names, opens the pull requests in opened.json, if any, leaves a demo for PR
// #77 and a folder without demo.json,
// copies session-db.json, if any, to the containers the fake `docker` lists (as `local-db.sh up` would),
// removes the run clone's scripts/git-hooks (as on a branch cut before the hook existed), commits once, records its
// arguments, the hooks path its clone sees and the gh calls made before it, runs the program $DURING_SESSION names
// when that is set, and exits with $CLAUDE_EXIT (after printing $CLAUDE_SAYS) when that is set. `served` is the repository the gh routes answer for, and `options` go to
// runnerSetup (the Triphammer config and the project file). The Triphammer config turns the demo and codex modules on unless `config`
// says otherwise.
function ticketSetup(t, issues = [issue(7)], {served = repo, files = {}, config = {}, ...options} = {}) {
  const r = runnerSetup(t, {
    ...options,
    config: {MODULES: 'demo,codex', ...config},
    files: {
      'plugins/triphammer/skills/ticket-run/SKILL.md': 'run the ticket\n',
      'scripts/local-db.sh': readFileSync(join(exampleProject, 'scripts/local-db.sh'), 'utf8'),
      'scripts/git-hooks/commit-msg': readFileSync(join(here, '../scripts/git-hooks/commit-msg'), 'utf8'),
      'bin/publish-demos': readFileSync(join(here, 'publish-demos'), 'utf8'),
      'bin/demo-publish': `#!/bin/sh
[ "$1" = --reindex ] && { echo reindex >> "$PROBE/reindex-calls"; exit 0; }
printf '%s|' "$@" >> "$DEMO_CALLS"; echo >> "$DEMO_CALLS"
[ -z "$DEMO_FAIL" ] || { echo "ffmpeg: conversion failed" >&2; exit 1; }
[ -f "$4/demo.json" ] && echo "published PR #$1"
`,
      ...files,
      'bin/security-review': `#!/bin/sh
echo "$*" >> "$PROBE/security-calls"
cp "$XDG_STATE_HOME/ticket-runner/current" "$PROBE/review-current" 2>/dev/null || true
[ -f "$PROBE/claude-args" ] && echo "the session had run"
[ -z "$SECURITY_FAIL" ] || { echo "gh: network down" >&2; exit 1; }
`,
    },
    gh: {
      [`issue list -R ${served} --state all --limit 1000`]: {file: 'issues.json'},
      [`pr list -R ${served} --state open`]: {file: 'pulls.json'},
      'issue create': {stdout: `https://github.com/${served}/issues/90\n`},
    },
    bin: {...(options.bin ?? {}),
      claude: `#!/bin/sh
printf '%s\\n' "$@" > "$PROBE/claude-args"
printf '%s' "$TRIPHAMMER_SESSION" > "$PROBE/triphammer-session"
printf '%s' "$GITHUB_APP_OWNER" > "$PROBE/app-owner"
printf '%s' "$TRIPHAMMER_OWNER" > "$PROBE/triphammer-owner"
printf '%s' "$TRIPHAMMER_PROPOSALS" > "$PROBE/proposals-path"
printf '%s' "$TRIPHAMMER_TOKEN_FILE" > "$PROBE/token-file"
cat "$TRIPHAMMER_TOKEN_FILE" > "$PROBE/token-at-start" 2>/dev/null || true
[ -s "$TRIPHAMMER_PROPOSALS" ] && echo "not empty" > "$PROBE/proposals-at-start"
[ ! -f "$PROBE/proposals.jsonl" ] || cat "$PROBE/proposals.jsonl" >> "$TRIPHAMMER_PROPOSALS"
[ ! -f "$PROBE/no-proposals" ] || rm -f "$TRIPHAMMER_PROPOSALS"
cp "$XDG_STATE_HOME/ticket-runner/current" "$PROBE/current" 2>/dev/null || true
pid="$(sed -n 's/^pid //p' "$PROBE/current" 2>/dev/null)"
[ -z "$pid" ] || { readlink "/proc/$pid/fd/9" > "$PROBE/holder-lock"; cut -d')' -f2- "/proc/$pid/stat" | cut -d' ' -f21 > "$PROBE/holder-started"; }
[ ! -f "$PROBE/opened.json" ] || cp "$PROBE/opened.json" "$PROBE/gh/pulls.json"
[ ! -f "$PROBE/session-db.json" ] || cp "$PROBE/session-db.json" "$PROBE/docker/ps.json"
mkdir -p artifacts/web-demo/results/risk-journey artifacts/web-demo/results/stray
echo '{"pr": 77, "summary": "The risk panel shows the new greeks"}' > artifacts/web-demo/results/risk-journey/demo.json
git config core.hooksPath > "$PROBE/hooks-path"
rm -r scripts/git-hooks
echo work > work.txt && git add work.txt && git commit -q -m "Do the work"
git log -1 --format=%B > "$PROBE/message"
cp "$PROBE/gh/calls" "$PROBE/calls-at-session"
[ -z "$DURING_SESSION" ] || "$DURING_SESSION"
[ -z "$CLAUDE_SAYS" ] || echo "$CLAUDE_SAYS"
[ -z "$CLAUDE_EXIT" ] || exit "$CLAUDE_EXIT"
`,
    },
  });
  r.gh.json('issues.json', issues);
  r.gh.json('pulls.json', []);
  const ghCalls = r.gh.calls;
  return {
    ...r,
    tick: (env = {}, args = []) =>
      r.runTicketRunner(args, {DEMO_CALLS: join(r.root, 'demo-calls'), PROBE: r.root, ...env}),
    worktree: join(r.checkout, '.worktrees/issue-7'),
    demoCalls: () => lines(join(r.root, 'demo-calls')),
    reindexCalls: () => lines(join(r.root, 'reindex-calls')),
    securityCalls: () => lines(join(r.root, 'security-calls')),
    probe: name => readFileSync(join(r.root, name), 'utf8'),
    ghCalls,
    creates: () => ghCalls().filter(call => call[0] === 'issue' && call[1] === 'create'),
    ran: () => existsSync(join(r.root, 'claude-args')),
    attemptsFile: join(r.root, 'state/ticket-runner/attempts/ticket-90'),
    current: join(r.root, 'state/ticket-runner/current'),
  };
}

test('after a session the runner publishes the demo it left, with its pull request number and summary', t => {
  const r = ticketSetup(t);
  r.tick();
  const folder = join(r.worktree, 'artifacts/web-demo/results/risk-journey');
  assert.deepEqual(r.demoCalls(), [`77|--summary|The risk panel shows the new greeks|${folder}|`]);
  const log = r.log();
  assert.match(log, /ticket #7: demo risk-journey: published PR #77/);
  assert.match(log, /ticket #7: demo stray: no demo.json; not published/);
  assert.match(log, /ticket #7: run 1 ended without progress/);
});

test('the demo is published before a run that progressed removes its clone', t => {
  const r = ticketSetup(t);
  r.gh.respond({'issue view 7': {stdout: 'yes\n'}});
  r.tick();
  assert.match(r.log(), /ticket #7: demo risk-journey: published PR #77/);
  assert.match(r.log(), /ticket #7: run 1 finished/);
  assert.equal(existsSync(r.worktree), false);
});

test('a run that progressed stops its database before it removes its clone, on the daemon swept after the session', t => {
  const r = ticketSetup(t);
  const project = localDb(r.worktree);
  writeFileSync(join(r.root, 'session-db.json'), JSON.stringify([[project, join(r.worktree, 'database')]]));  // local-db.sh up
  r.gh.respond({'issue view 7': {stdout: 'yes\n'}});
  r.tick();
  assert.ok(r.docker.calls().some(call => call.startsWith(`${project}|compose --file `) && call.endsWith(' down --volumes --remove-orphans')));
  assert.ok(r.docker.hosts().some(call => call.startsWith(`${r.dockerHost}|compose --file `)), 'the teardown gets the rootless daemon');
  const log = r.log();
  assert.ok(log.indexOf('after the session: removed 1 container ') < log.indexOf('run 1 finished'), log);
  assert.doesNotMatch(log, /teardown failed/, 'a teardown on the swept daemon still works');
  assert.equal(existsSync(r.worktree), false);
});

test('a failed publish is logged and the run carries on', t => {
  const r = ticketSetup(t);
  r.tick({DEMO_FAIL: '1'});
  const log = r.log();
  assert.match(log, /ticket #7: demo risk-journey: ffmpeg: conversion failed/);
  assert.match(log, /ticket #7: demo risk-journey: demo-publish for PR #77 failed \(exit 1\)/);
  assert.match(log, /ticket #7: run 1 ended without progress/);
});

// What a run's clone is: a repository of its own on `branch` at `head`, whose objects come from the main checkout
// through an alternate, with the main checkout's origin and Triphammer's hooks, and of which the main checkout's .git
// knows nothing.
function assertRunClone(r, dir, branch, head) {
  assert.equal(statSync(join(dir, '.git')).isDirectory(), true, 'the run has a .git of its own');
  assert.equal(readFileSync(join(dir, '.git/objects/info/alternates'), 'utf8').trim(), join(r.checkout, '.git/objects'));
  assert.equal(git(dir, 'config', 'core.hooksPath'), join(r.checkout, 'scripts/git-hooks'));
  assert.equal(git(dir, 'remote', 'get-url', 'origin'), git(r.checkout, 'remote', 'get-url', 'origin'));
  assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD'), branch);
  assert.equal(git(dir, 'rev-parse', 'HEAD^'), head, "the session's commit is on the branch from origin");
  assert.throws(() => git(r.checkout, 'cat-file', '-e', git(dir, 'rev-parse', 'HEAD')),
    "the session's commit is not in the main checkout's store");
  assert.equal(existsSync(join(r.checkout, '.git/worktrees')), false, 'the main checkout has no worktree');
}

test("a ticket run works in a clone of its own on ticket/N from origin/main, reading the main checkout's objects through an alternate", t => {
  const r = ticketSetup(t);
  r.tick();
  assert.match(r.probe('claude-args'), /You are in a fresh clone on branch ticket\/7 from origin\/main/);
  assertRunClone(r, r.worktree, 'ticket/7', git(r.checkout, 'rev-parse', 'origin/main'));
});

test("a repair run works in a clone of its own on the pull request's branch", t => {
  const r = repairSetup(t);
  const head = git(join(r.root, 'publisher'), 'rev-parse', 'ticket/30');
  r.tick();
  assertRunClone(r, join(r.checkout, '.worktrees/pr-40'), 'ticket/30', head);
});

test("a run's clone takes the place of the one an earlier run left", t => {
  const r = ticketSetup(t);
  r.tick();
  writeFileSync(join(r.worktree, 'left.txt'), 'left by run 1\n');
  writeFileSync(join(r.worktree, '.git/planted'), 'left by run 1\n');
  r.tick();
  assert.match(r.log(), /ticket #7: run 2 of 3 starting/);
  assert.equal(existsSync(join(r.worktree, 'left.txt')), false);
  assert.equal(existsSync(join(r.worktree, '.git/planted')), false);
  assertRunClone(r, r.worktree, 'ticket/7', git(r.checkout, 'rev-parse', 'origin/main'));
});

test("the runner's run clones run the main checkout's hooks even without their own copy", t => {
  const r = ticketSetup(t);
  r.tick();
  assert.equal(r.probe('hooks-path'), `${join(r.checkout, 'scripts/git-hooks')}\n`);
  assert.equal(r.probe('message'), 'Do the work\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n\n');
  assert.throws(() => git(r.checkout, 'config', 'core.hooksPath'), 'the main checkout has no hooks path');
});

test("the session runs as the plugin's orchestrator agent on Opus", t => {
  const r = ticketSetup(t);
  r.tick();
  const args = r.probe('claude-args').split('\n');
  assert.equal(args[args.indexOf('--agent') + 1], 'triphammer:orchestrator');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.match(r.probe('claude-args'), /Follow the triphammer:ticket-run skill\./);
});

// Cleanup proposals (bin/README.md, Cleanup proposals).

const flagValue = (call, flag) => call[call.indexOf(flag) + 1];
const proposal = (mechanism, extra = {}) => ({title: `Share ${mechanism}`, mechanism,
  locations: ['bin/a:10', 'bin/b:20', 'bin/c:30'], fix: `One helper for ${mechanism} in bin/shared.sh`, ...extra});
const markerOf = slug => `<!-- triphammer-cleanup: ${slug} -->`;
// A ticket whose session appends `content` to its proposals file (none when undefined).
function proposalsTick(t, content, routes = {}) {
  const r = ticketSetup(t);
  if (content !== undefined) writeFileSync(join(r.root, 'proposals.jsonl'), content);
  r.gh.respond(routes);
  r.tick();
  const filed = r.creates().map(call =>
    ({title: flagValue(call, '--title'), label: flagValue(call, '--label'), body: flagValue(call, '--body')}));
  return {...r, filed, path: r.probe('proposals-path')};
}
const openBodies = `issue list -R ${repo} --state open --limit 1000 --json body`;

test('the session gets an empty proposals file outside its clone, which the run removes when it ends', t => {
  const r = proposalsTick(t);
  assert.ok(r.path.startsWith('/'), r.path);
  assert.ok(!r.path.startsWith(`${r.checkout}/`), `the proposals file ${r.path} lies in the checkout`);
  assert.ok(!r.path.startsWith(`${r.worktree}/`), `the proposals file ${r.path} lies in the worktree`);
  assert.equal(existsSync(join(r.root, 'proposals-at-start')), false, 'the file was not empty');
  assert.equal(existsSync(join(r.path, '..')), false, 'the proposals directory outlived the run');
  assert.deepEqual(r.filed, []);
});

test('each proposal the session leaves is filed as an issue labelled cleanup with its mechanism\'s marker', t => {
  const content = `${JSON.stringify(proposal('Retry loop around gh'))}\n${JSON.stringify(proposal('stat_mtime'))}`;
  const r = proposalsTick(t, content);
  assert.deepEqual(r.filed.map(({title, label}) => [title, label]),
    [['Share Retry loop around gh', 'cleanup'], ['Share stat_mtime', 'cleanup']]);
  assert.ok(r.filed[0].body.startsWith(`${markerOf('retry-loop-around-gh')}\n`), r.filed[0].body);
  assert.ok(r.filed[1].body.startsWith(`${markerOf('stat-mtime')}\n`), r.filed[1].body);
  for (const location of ['bin/a:10', 'bin/b:20', 'bin/c:30']) assert.match(r.filed[0].body, new RegExp(`^> - ${location}$`, 'm'));
  assert.match(r.filed[1].body, /^> One helper for stat_mtime in bin\/shared\.sh$/m);
  assert.match(r.filed[0].body, /while it worked on issue #7\./);
  assert.match(r.log(), /ticket #7: filed #90 for the proposed cleanup of retry-loop-around-gh/);
  assert.match(r.log(), /ticket #7: run 1 ended without progress/);
});

test('a proposal whose marker an open issue holds, or that an earlier line repeats, is not filed again', t => {
  const content = [proposal('Retry loop'), proposal('stat mtime'), proposal('STAT-mtime!', {title: 'Again'})]
    .map(p => JSON.stringify(p)).join('\n');
  const r = proposalsTick(t, `${content}\n`,
    {[openBodies]: {stdout: `Some issue\n${markerOf('retry-loop')}\nmore text\n${markerOf('stat-mtime-old')}\n`}});
  assert.deepEqual(r.filed.map(({title}) => title), ['Share stat mtime']);
  assert.match(r.log(), /ticket #7: an open issue already proposes the mechanism retry-loop; skipped/);
  assert.match(r.log(), /ticket #7: proposal on line 3 repeats the mechanism stat-mtime; skipped/);
});

test('an empty or missing proposals file files nothing and logs nothing about proposals', t => {
  for (const setup of [r => writeFileSync(join(r.root, 'proposals.jsonl'), '\n  \n'),
    r => writeFileSync(join(r.root, 'no-proposals'), '')]) {
    const r = ticketSetup(t);
    setup(r);
    r.tick();
    assert.deepEqual(r.creates(), []);
    assert.ok(!r.ghCalls().some(call => call.join(' ').startsWith(openBodies)), 'the open issues were listed');
    assert.doesNotMatch(r.log(), /propos/);
    assert.match(r.log(), /ticket #7: run 1 ended without progress/);
  }
});

test('a malformed proposal is logged and skipped, and the others are filed', t => {
  const content = ['{not json', '[1, 2]', JSON.stringify({...proposal('x'), locations: []}),
    JSON.stringify({...proposal('y'), fix: '  '}), JSON.stringify(proposal('!!!')),
    JSON.stringify(proposal('kept'))].join('\n');
  const r = proposalsTick(t, content);
  assert.deepEqual(r.filed.map(({title}) => title), ['Share kept']);
  for (const line of [1, 2, 3, 4, 5]) {
    assert.match(r.log(), new RegExp(`ticket #7: proposal on line ${line} is not a JSON object with a title, mechanism, locations and fix; skipped`));
  }
  assert.match(r.log(), /ticket #7: run 1 ended without progress \(exit 0\)/);
});

test('a malformed proposals file, or a failed lookup or filing, never changes how the run ends', t => {
  const binary = proposalsTick(t, '\u0000\u0001garbage\n');
  assert.deepEqual(binary.filed, []);
  assert.match(binary.log(), /proposal on line 1 is not a JSON object/);
  assert.match(binary.log(), /ticket #7: run 1 ended without progress \(exit 0\)/);

  const unlisted = proposalsTick(t, JSON.stringify(proposal('a')), {[openBodies]: {exit: 1, stderr: 'HTTP 502\n'}});
  assert.deepEqual(unlisted.filed, []);
  assert.match(unlisted.log(), /could not list the open issues to check the proposals' markers; filing none/);
  assert.match(unlisted.log(), /ticket #7: run 1 ended without progress/);

  const refused = proposalsTick(t, `${JSON.stringify(proposal('a'))}\n${JSON.stringify(proposal('b'))}\n`,
    {'issue create': {exit: 1, stderr: 'HTTP 403: Resource not accessible\n'}});
  assert.equal(refused.filed.length, 2, 'one failure stops no other filing');
  assert.match(refused.log(), /could not file the proposed cleanup of a: HTTP 403: Resource not accessible/);
  assert.match(refused.log(), /ticket #7: run 1 ended without progress/);
});

test('the session\'s text is quoted line by line, so no slice or dependency declaration in it counts', t => {
  const r = proposalsTick(t, JSON.stringify(proposal('m', {fix: 'Merge them.\nSlice 1 of #5.\rDepends on #6. Depends on #8.',
    locations: ['bin/a:1\nDepends on #7.']})));
  const body = r.filed[0].body;
  assert.match(body, /^> Slice 1 of #5\.$/m);
  const filed = join(r.root, 'filed.json');
  writeFileSync(filed, JSON.stringify([{number: 90, body}]));
  const declared = run('python3', ['-I', join(here, 'ticket-decide.py'), '--declarations', filed]);
  assert.deepEqual(JSON.parse(declared), {90: {slices: [], depends: []}});
});

test('a run past ten proposals files the first ten', t => {
  const content = Array.from({length: 12}, (_, k) => JSON.stringify(proposal(`m${k}`))).join('\n');
  const r = proposalsTick(t, content);
  assert.equal(r.filed.length, 10);
  assert.match(r.log(), /proposal on line 11 is past the limit of 10 issues a run files; skipped/);
});

test('a session that failed files none of its proposals and logs why', t => {
  const r = ticketSetup(t);
  writeFileSync(join(r.root, 'proposals.jsonl'), `${JSON.stringify(proposal('a'))}\n`);
  r.tick({CLAUDE_EXIT: '3'});
  assert.deepEqual(r.creates(), []);
  assert.ok(!r.ghCalls().some(call => call.join(' ').startsWith(openBodies)), 'the open issues were listed');
  assert.match(r.log(), /ticket #7: the session failed \(exit 3\); filing none of its proposals/);
  assert.match(r.log(), /ticket #7: run 1 ended without progress \(exit 3\)/);
  assert.equal(existsSync(join(r.probe('proposals-path'), '..')), false, 'the proposals directory outlived the run');
});

test('a run on a cleanup issue files none of its session\'s proposals and logs why', t => {
  const r = ticketSetup(t, [issue(7, {labels: ['cleanup']})]);
  writeFileSync(join(r.root, 'proposals.jsonl'), `${JSON.stringify(proposal('a'))}\n${JSON.stringify(proposal('b'))}\n`);
  r.tick();
  assert.deepEqual(r.creates(), []);
  assert.ok(!r.ghCalls().some(call => call.join(' ').startsWith(openBodies)), 'the open issues were listed');
  assert.match(r.log(), /ticket #7: issue #7 is labelled cleanup; filing none of the session's 2 proposals/);
  assert.match(r.log(), /ticket #7: run 1 ended without progress \(exit 0\)/);
});

test('a run on an issue labelled Cleanup, in another case, files none of its session\'s proposals', t => {
  const r = ticketSetup(t, [issue(7, {labels: ['Cleanup']})]);
  writeFileSync(join(r.root, 'proposals.jsonl'), `${JSON.stringify(proposal('a'))}\n`);
  r.tick();
  assert.deepEqual(r.creates(), []);
  assert.match(r.log(), /ticket #7: issue #7 is labelled cleanup; filing none of the session's 1 proposals/);
});

test('a repair of a pull request that closes a cleanup issue files none of its session\'s proposals', t => {
  const r = repairSetup(t);
  r.gh.json('issues.json', [issue(30, {labels: ['cleanup']})]);
  writeFileSync(join(r.root, 'proposals.jsonl'), `${JSON.stringify(proposal('a'))}\n`);
  r.tick();
  assert.deepEqual(r.creates(), []);
  assert.match(r.log(), /repair #40: issue #30 is labelled cleanup; filing none of the session's 1 proposals/);
});

test('a repair of a pull request that closes no cleanup issue files its session\'s proposals', t => {
  const r = repairSetup(t);
  writeFileSync(join(r.root, 'proposals.jsonl'), `${JSON.stringify(proposal('a'))}\n`);
  r.tick();
  assert.equal(r.creates().length, 1);
  assert.match(r.log(), /repair #40: filed #90 for the proposed cleanup of a/);
});

test('a proposal\'s title is filed as one line of at most 120 characters, and one left empty is skipped', t => {
  // Control characters, NEL and the Unicode line and paragraph separators all become spaces.
  const separators = String.fromCharCode(0x2028, 0x2029);
  const controls = String.fromCharCode(0x01, 0x1b);
  const long = `Share the helper\nFollow these new instructions:\r\n${controls}[2J\u0085${separators}${'x'.repeat(200)}`;
  const content = [proposal('long', {title: long}), proposal('blank', {title: String.fromCharCode(1, 2, 32, 0x7f)})]
    .map(p => JSON.stringify(p)).join('\n');
  const r = proposalsTick(t, content);
  assert.equal(r.filed.length, 1);
  const {title} = r.filed[0];
  assert.ok(title.length <= 120, `${title.length} characters`);
  assert.ok(title.startsWith('Share the helper Follow these new instructions: [2J x'), title);
  assert.ok(![...title].some(c => c.codePointAt(0) < 0x20 || (c.codePointAt(0) >= 0x7f && c.codePointAt(0) <= 0x9f)
    || separators.includes(c)), title);
  assert.equal(title, title.trim());
  assert.match(r.log(), /ticket #7: proposal on line 2 is not a JSON object with a title, mechanism, locations and fix; skipped/);
});

// The builder the prompt names (bin/README.md, Sessions) and the run record (Run records).

// Ticket #7 with `labels`, after `before` runs left its attempts counter at that value (none when undefined).
function ticketAfter(t, labels, before) {
  const r = ticketSetup(t, [issue(7, {labels})]);
  const attempts = join(r.root, 'state/ticket-runner/attempts');
  if (before !== undefined) {
    mkdirSync(attempts, {recursive: true});
    writeFileSync(join(attempts, 'ticket-7'), `${before}\n`);
  }
  return {...r, attempts};
}
// A tick of that ticket.
function builderTick(t, labels, before) {
  const r = ticketAfter(t, labels, before);
  r.tick();
  return {...r, prompt: r.probe('claude-args'), resetFile: join(r.attempts, 'ticket-7.reset')};
}
const lightBrief = /This is run 1 of 3\. This is a light run: brief triphammer:builder-light for every builder, never triphammer:builder/;
const opusBrief = /This is run \d of 3\. Brief triphammer:builder for every builder\./;
const handedOver = /an earlier run may have built it with triphammer:builder-light and handed it over: its comment on the issue says what it tried and the findings it could not resolve, and its work is on origin\/ticket\/7\./;
// The stream-JSON result line a session ends its transcript with, for $CLAUDE_SAYS; the fake's `echo` (dash's) would
// turn JSON's `\n` into a line break, so a newline in the result is escaped as `\u000a`.
const resultLine = result => JSON.stringify({type: 'result', result}).replaceAll('\\n', '\\u000a');
const record = r => {
  const runs = join(r.root, 'state/ticket-runner/runs');
  const files = readdirSync(runs).filter(file => file.endsWith('.json'));
  assert.equal(files.length, 1, files.join(' '));
  assert.ok(existsSync(join(runs, files[0].replace(/\.json$/, '.jsonl'))), 'the record sits beside its transcript');
  return JSON.parse(readFileSync(join(runs, files[0]), 'utf8'));
};

test('run 1 of a ticket whose issue is labelled light briefs the Sonnet builder; the session itself stays on Opus', t => {
  const r = builderTick(t, ['light']);
  assert.match(r.prompt, lightBrief);
  const args = r.prompt.split('\n');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--agent') + 1], 'triphammer:orchestrator');
  assert.deepEqual([record(r).builder, record(r).builderModel], ['triphammer:builder-light', 'sonnet']);
});

test('runs 2 and 3 of a light ticket brief the Opus builder and point at the light run\'s comment and branch', t => {
  for (const before of [1, 2]) {
    const r = builderTick(t, ['light'], before);
    assert.match(r.prompt, opusBrief, `after ${before}`);
    assert.match(r.prompt, handedOver);
    assert.doesNotMatch(r.prompt, /This is a light run/);
    assert.deepEqual([record(r).run, record(r).builderModel], [before + 1, 'opus']);
  }
});

test('after the owner removes needs-owner, run 1 of the restarted counter of a light ticket briefs the Opus builder', t => {
  const r = builderTick(t, ['light'], 3);
  assert.match(r.prompt, /This is run 1 of 3\. Brief triphammer:builder for every builder\./);
  assert.match(r.prompt, handedOver);
  assert.equal(existsSync(r.resetFile), true, 'the restart is recorded');
  assert.equal(record(r).builderModel, 'opus');

  // The restart outlives a run the brake stops, which is not counted, and goes with the counter once a run progresses.
  const braked = ticketAfter(t, ['light'], 3);
  const stop = join(braked.root, 'state/ticket-runner/stop');
  brakeSession(braked)({BRAKE_FILE: stop});
  assert.match(braked.log(), /ended by the owner's brake/);
  rmSync(stop);
  braked.tick();
  assert.match(braked.probe('claude-args'), /This is run 1 of 3\. Brief triphammer:builder for every builder\./);

  const progressed = ticketAfter(t, ['light'], 3);
  progressed.gh.respond({'issue view 7': {stdout: 'yes\n'}});
  progressed.tick();
  assert.equal(existsSync(join(progressed.attempts, 'ticket-7')), false);
  assert.equal(existsSync(join(progressed.attempts, 'ticket-7.reset')), false);
});

test('an unlabelled ticket briefs the Opus builder on every run, restarted or not, with no word of a light run', t => {
  for (const before of [undefined, 1, 3]) {
    const r = builderTick(t, ['next'], before);
    assert.match(r.prompt, opusBrief, `after ${before}`);
    assert.doesNotMatch(r.prompt, /light/);
    assert.equal(record(r).builder, 'triphammer:builder');
  }
});

test('the run record holds the pull request opened on the branch since the start and the rounds and handoff the session reported', t => {
  const says = resultLine('No pull request: handed over to the next run.\nRun record: review-rounds=3 handoff=yes');
  const r = ticketSetup(t, [issue(7, {labels: ['light']})]);
  r.gh.respond({[`pr list -R ${repo} --state all --head ticket/7`]: {file: 'branch-prs.json'}});
  r.gh.json('branch-prs.json', [{number: 60, createdAt: '2001-01-01T00:00:00Z'}, {number: 70, createdAt: '2999-01-01T00:00:00Z'}]);
  r.tick({CLAUDE_SAYS: says});
  assert.deepEqual(record(r), {kind: 'ticket', number: 7, run: 1, builder: 'triphammer:builder-light', builderModel: 'sonnet',
    exit: 0, pullRequestOpened: true, reviewRounds: 3, handoff: true});

  const older = ticketSetup(t);
  older.gh.respond({[`pr list -R ${repo} --state all --head ticket/7`]: {file: 'branch-prs.json'}});
  older.gh.json('branch-prs.json', [{number: 60, createdAt: '2001-01-01T00:00:00Z'}]);
  older.tick({CLAUDE_SAYS: resultLine('PR #70, auto.\nRun record: review-rounds=1 handoff=no')});
  assert.deepEqual([record(older).pullRequestOpened, record(older).reviewRounds, record(older).handoff], [false, 1, false]);
});

test('what the run record cannot read is null: a failed pull request lookup, a session without the line, a line not in its result', t => {
  for (const says of [undefined, 'Run record: review-rounds=2 handoff=no',
    resultLine('Run record: review-rounds=two handoff=no')]) {
    const r = ticketSetup(t);
    r.gh.respond({[`pr list -R ${repo} --state all --head ticket/7`]: {exit: 1, stderr: 'HTTP 502\n'}});
    r.tick(says === undefined ? {CLAUDE_EXIT: '1'} : {CLAUDE_SAYS: says});
    const {pullRequestOpened, reviewRounds, handoff, exit} = record(r);
    assert.deepEqual({pullRequestOpened, reviewRounds, handoff}, {pullRequestOpened: null, reviewRounds: null, handoff: null}, says);
    assert.equal(exit, says === undefined ? 1 : 0);
  }
});

test('a repair briefs the Opus builder, and its record says it opened no pull request', t => {
  const r = repairSetup(t, {files: {}});
  r.gh.respond({[`pr list -R ${repo} --state all --head ticket/30`]: {file: 'branch-prs.json'}});
  r.gh.json('branch-prs.json', [{number: 40, createdAt: '2001-01-01T00:00:00Z'}]);
  r.tick();
  assert.match(r.probe('claude-args'), /This is run 1 of 3\. Brief triphammer:builder for every builder\./);
  const {kind, number, builderModel, pullRequestOpened} = record(r);
  assert.deepEqual({kind, number, builderModel, pullRequestOpened}, {kind: 'repair', number: 40, builderModel: 'opus', pullRequestOpened: false});
});

test("the session gets the token of the App's installation on the served repository's account", t => {
  const r = ticketSetup(t);
  r.tick({GITHUB_APP_OWNER: 'someone-else'});
  assert.equal(r.probe('app-owner'), 'Example-Owner');
});

// The session's token directory and file in the fixture's shared directory, and the directory of every session's.
const tokenPaths = r => {
  const tokens = join(r.root, 'state/triphammer/tokens');
  return {tokens, dir: join(tokens, 'triphammer'), file: join(tokens, 'triphammer/token.json')};
};

for (const [kind, setup] of [['ticket', ticketSetup], ['repair', repairSetup]]) {
  test(`a ${kind} run mints the session's token for the served account before it starts, hands the session its file alone, and removes it after`, t => {
    const r = setup(t);
    r.tick({GITHUB_APP_OWNER: 'someone-else'});
    const {tokens, dir, file} = tokenPaths(r);
    assert.equal(r.probe('token-file'), file);
    assert.deepEqual(JSON.parse(r.probe('token-at-start')),
      {account: 'Example-Owner', token: 'ghs_session_1', expires_at: '2099-01-01T00:00:00Z'});
    assert.equal(r.tokenCalls()[0], `session-file ${file} Example-Owner`);
    const session = r.bwrapCalls().at(-1);
    const mounts = session.slice(0, session.indexOf('--')).join(' ');
    assert.ok(mounts.includes(`--tmpfs ${realpathSync(tokens)}`), mounts);
    const own = join(realpathSync(tokens), 'triphammer');
    assert.ok(mounts.endsWith(`--ro-bind ${own} ${own}`), mounts);
    assert.equal(existsSync(dir), false, "the session's token directory outlived the run");
  });
}

test("the session's token file is rewritten while the session runs, and the rewriting stops when it ends", async t => {
  const r = ticketSetup(t);
  const {dir, file} = tokenPaths(r);
  const script = join(r.root, 'during-session');
  writeFileSync(script, `#!/bin/sh
for i in $(seq 200); do cmp -s '${file}' "$PROBE/token-at-start" || break; sleep 0.05; done
cat '${file}' > "$PROBE/token-later"
`, {mode: 0o755});
  r.tick({DURING_SESSION: script, TICKET_RUNNER_TOKEN_SECONDS: '0.1'});
  const [start, later] = ['token-at-start', 'token-later'].map(name => Number(/"ghs_session_(\d+)"/.exec(r.probe(name))?.[1]));
  assert.ok(later > start, `the token went from ${start} to ${later}`);
  const calls = r.tokenCalls().length;
  assert.ok(calls >= later, `${calls} calls`);
  assert.ok(r.tokenCalls().every(call => call === `session-file ${file} Example-Owner`), r.tokenCalls().join('\n'));
  await new Promise(done => setTimeout(done, 500));
  assert.equal(r.tokenCalls().length, calls, 'the token was rewritten after the run ended');
  assert.equal(existsSync(dir), false);
});

test('a session whose token cannot be minted does not start, is not counted, and the log says why', t => {
  const r = ticketSetup(t);
  assert.throws(() => r.tick({TOKEN_FAIL: 'the App is not installed for Example-Owner'}), error => error.status === 1);
  assert.equal(r.ran(), false);
  assert.match(r.log(), /ticket #7: no GitHub token for the session, so none starts; not counted: github-app-token: the App is not installed for Example-Owner/);
  assert.equal(readFileSync(join(r.root, 'state/ticket-runner/attempts/ticket-7'), 'utf8').trim(), '0');
  assert.deepEqual(labelCalls(r.ghCalls()).slice(-1), [`issue edit 7 -R ${repo} --remove-label agent-working`]);
  assert.equal(existsSync(tokenPaths(r).dir), false);
});

test('a bad TICKET_RUNNER_TOKEN_SECONDS stops the runner before any gh call', t => {
  for (const seconds of ['0', 'soon', '-1']) {
    const r = ticketSetup(t);
    assert.throws(() => r.tick({TICKET_RUNNER_TOKEN_SECONDS: seconds}), error => error.status === 2
      && /TICKET_RUNNER_TOKEN_SECONDS must be a positive number of seconds/.test(error.stderr));
    assert.deepEqual(r.ghCalls(), []);
  }
});

test("the session is marked as Triphammer's, with its clone as the place the agent guard lets it write", t => {
  const r = ticketSetup(t);
  r.tick();
  assert.equal(r.probe('triphammer-session'), r.worktree);
});

test("the session loads the Triphammer plugin from the main checkout, never from the run's clone", t => {
  const r = ticketSetup(t);
  r.tick();
  const args = r.probe('claude-args').split('\n');
  assert.equal(args.filter(arg => arg === '--plugin-dir').length, 1);
  const plugin = args[args.indexOf('--plugin-dir') + 1];
  assert.equal(plugin, join(r.checkout, 'plugins/triphammer'));
  assert.ok(!plugin.startsWith(r.worktree), plugin);
  assert.equal(readFileSync(join(plugin, 'skills/ticket-run/SKILL.md'), 'utf8'), 'run the ticket\n');
});

test("a project that is another repository runs under Triphammer's plugin, and its clone's commits run Triphammer's hooks", t => {
  const r = ticketSetup(t);
  const project = r.separateProject();
  for (const path of ['plugins', 'scripts/git-hooks', 'scripts/land-pr.sh']) assert.equal(existsSync(join(project.checkout, path)), false, path);
  r.tick();
  const worktree = join(project.checkout, '.worktrees/issue-7');
  assert.equal(r.probe('triphammer-session'), worktree, "the session runs in the project's clone");
  const args = r.probe('claude-args').split('\n');
  assert.equal(args[args.indexOf('--plugin-dir') + 1], join(r.checkout, 'plugins/triphammer'));
  assert.equal(r.probe('hooks-path'), `${join(r.checkout, 'scripts/git-hooks')}\n`);
  assert.equal(r.probe('message'), 'Do the work\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n\n');
  assert.equal(existsSync(join(r.checkout, '.worktrees')), false, "Triphammer's checkout gets no worktree");
});

test("a project that is another repository starts no session until Triphammer's main has the ticket-run skill", t => {
  const r = ticketSetup(t, [issue(7)], {files: {'plugins/triphammer/skills/ticket-run/SKILL.md': null}});
  r.separateProject({'.triphammer/project.json': projectJson,
    'plugins/triphammer/skills/ticket-run/SKILL.md': "the project's own copy\n"});
  r.tick();
  assert.equal(r.ran(), false);
});

test('a main without the plugin\'s ticket-run skill starts no session', t => {
  const r = ticketSetup(t, [issue(7)], {files: {'plugins/triphammer/skills/ticket-run/SKILL.md': null}});
  r.tick();
  assert.equal(r.ran(), false);
});

// The sessions' write limit (bin/session-sandbox; bin/README.md, The write limit), through the fixture's bwrap.
// The paths a bwrap call's `--bind` arguments make writable.
const binds = call => call.flatMap((arg, i) => arg === '--bind' ? [call[i + 1]] : []);

// Asserts a recorded bwrap call mounts / read-only and makes run writable, but not the main checkout or its .git.
function assertWriteLimit(r, call, run) {
  assert.ok(binds(call).includes(run), JSON.stringify(call));
  const mainGit = join(r.checkout, '.git');
  assert.ok(!binds(call).some(path => path === mainGit || path.startsWith(`${mainGit}/`)),
    `the main checkout's .git is not writable: ${JSON.stringify(call)}`);
  assert.ok(!binds(call).includes(r.checkout), 'the main checkout is not writable');
  assert.deepEqual(call.slice(call.indexOf('--ro-bind'), call.indexOf('--ro-bind') + 3), ['--ro-bind', '/', '/']);
}

// Asserts a recorded bwrap call hides every project's caches but makes the fixture project's own cache directory, in
// the shared directory's caches, writable and points the caches inside at it.
function assertProjectCaches(r, call) {
  const caches = realpathSync(join(r.root, 'state/triphammer/caches'));
  const own = join(caches, 'triphammer');
  const mounts = call.slice(0, call.indexOf('--')).join(' ');
  assert.ok(mounts.includes(`--tmpfs ${caches} --bind ${own} ${own}`), mounts);
  for (const [name, dir] of [['XDG_CACHE_HOME', 'xdg'], ['npm_config_cache', 'npm'], ['NUGET_PACKAGES', 'nuget/packages'],
    ['BUILDX_CONFIG', 'buildx']]) {
    assert.ok(mounts.includes(`--setenv ${name} ${join(own, dir)}`), `${name}: ${mounts}`);
  }
}

for (const [kind, setup, worktree] of [['ticket', ticketSetup, 'issue-7'], ['repair', repairSetup, 'pr-40']]) {
  test(`a ${kind} run's session runs under the write limit with the project's caches, after a dry run of it`, t => {
    const r = setup(t);
    r.tick();
    assert.equal(r.ran(), true);
    const calls = r.bwrapCalls();
    assert.equal(calls.length, 2, JSON.stringify(calls));
    const [dry, session] = calls;
    const run = join(r.checkout, '.worktrees', worktree);
    assert.deepEqual(dry.slice(dry.indexOf('--')), ['--', 'true']);
    assert.deepEqual(session.slice(session.indexOf('--'), session.indexOf('--') + 3), ['--', 'claude', '-p']);
    assert.ok(binds(dry).includes(r.checkout), JSON.stringify(dry));
    assertWriteLimit(r, session, run);
    for (const call of [dry, session]) assertProjectCaches(r, call);
    // What the sandbox makes writable, and so creates first, lies in the test's directory, not the machine's HOME.
    const root = realpathSync(r.root);
    const temporary = ['/tmp', realpathSync(tmpdir())];
    for (const path of [...binds(dry), ...binds(session)]) {
      assert.ok(path.startsWith(`${root}/`) || temporary.includes(path), `${path} lies outside the test's directory`);
    }
  });
}

// Whether a bwrap call hides `path`: an empty tmpfs over its directory, and no mount of the path itself.
const hides = (call, path) => call.some((arg, i) => arg === '--tmpfs' && call[i + 1] === dirname(path)) && !call.includes(path);

for (const [declared, docker, hidden] of [['without docker', undefined, true], ['with "docker": false', false, true],
  ['with "docker": true', true, false]]) {
  test(`a project's Docker setting reaches the write limit: a project ${declared} ${hidden ? 'gets no' : 'reaches the rootless'} Docker socket, and none gets the rootful one`, async t => {
    const r = ticketSetup(t, [issue(7)], {project: docker === undefined ? projectJson : `${JSON.stringify({...example, docker})}\n`});
    await listenUnix(t, r.dockerSocket);
    await listenUnix(t, r.otherDockerSocket);
    // The session's checks run Compose, as a project's gate does; DOCKER_HOST outside the runner is not the one it gets.
    const gate = join(r.root, 'gate.sh');
    writeFileSync(gate, `#!/bin/sh\nprintf '%s' "$DOCKER_HOST" > "$PROBE/session-docker-host"\ndocker compose -p example-gate up -d\n`,
      {mode: 0o755});
    r.tick({DOCKER_HOST: 'unix:///var/run/docker.sock', DURING_SESSION: gate});
    assert.equal(r.ran(), true);
    assert.equal(r.probe('session-docker-host'), r.dockerHost);
    assert.ok(r.docker.hosts().includes(`${r.dockerHost}|compose -p example-gate up -d`), r.docker.hosts().join('\n'));
    const calls = r.bwrapCalls();
    assert.equal(calls.length, 2, JSON.stringify(calls));
    for (const call of calls) {
      assert.equal(hides(call, realpathSync(r.dockerSocket)), hidden, JSON.stringify(call));
      assert.ok(hides(call, realpathSync(r.otherDockerSocket)), `another project's daemon is reached: ${JSON.stringify(call)}`);
      assert.ok(hides(call, '/run/docker.sock'), JSON.stringify(call));
    }
  });
}

test("each Docker project's sessions get its own rootless daemon as DOCKER_HOST, and every other project's daemon hidden", async t => {
  const r = ticketSetup(t, [issue(7)], {project: `${JSON.stringify({...example, docker: true})}\n`});
  await listenUnix(t, r.dockerSocket);
  await listenUnix(t, r.otherDockerSocket);
  const gate = join(r.root, 'gate.sh');
  writeFileSync(gate, `#!/bin/sh\nprintf '%s' "$DOCKER_HOST" > "$PROBE/session-docker-host"\n`, {mode: 0o755});
  r.tick({TRIPHAMMER_PROJECT: 'other-project', DURING_SESSION: gate});
  assert.equal(r.ran(), true);
  assert.equal(r.probe('session-docker-host'), `unix://${r.otherDockerSocket}`);
  const calls = r.bwrapCalls();
  assert.equal(calls.length, 2, JSON.stringify(calls));
  for (const call of calls) {
    assert.ok(hides(call, realpathSync(r.dockerSocket)), JSON.stringify(call));
    assert.ok(!hides(call, realpathSync(r.otherDockerSocket)), JSON.stringify(call));
  }
});

test('a project that declares Docker starts no session on a machine whose machine file names no rootless daemon', t => {
  const r = ticketSetup(t, [issue(7)], {project: `${JSON.stringify({...example, docker: true})}\n`});
  r.noRootlessDaemon();
  assert.throws(() => r.tick({DOCKER_HOST: 'unix:///var/run/docker.sock'}), error => error.status === 1);
  assert.equal(r.ran(), false);
  assert.match(r.log(), /ticket #7: this project declares "docker": true, but the machine file names no rootless Docker daemon of this project, so no session starts \(run sudo triphammer update/);
  assert.deepEqual(r.bwrapCalls(), [], 'not even the dry run of the write limit');
  assert.equal(existsSync(join(r.root, 'state/ticket-runner/attempts/ticket-7')), false, 'the run is not counted');
});

// The calls of the daemon sweep (sweep_daemon) on the project's daemon, and the session's `docker info` that marks where
// the session ran.
const daemonSweep = r => r.docker.hosts().filter(call => /\|(info|swarm |plugin |ps -aq|rm |volume prune|network prune|image prune|builder prune)/.test(call));
const swarmState = host => `${host}|info --format {{.Swarm.LocalNodeState}}`;
const prunes = host => [`${host}|volume prune -af`, `${host}|network prune -f`, `${host}|image prune -af`, `${host}|builder prune -af`];

test("the project's own Docker daemon is swept clean right before the session and again right after it", t => {
  const r = ticketSetup(t);
  const db = localDb(r.worktree);
  r.docker.containers([['left-behind', '']]);  // a container an earlier session started, not a database of the sweep's
  writeFileSync(join(r.root, 'session-db.json'), JSON.stringify([[db, join(r.worktree, 'database')]]));  // local-db.sh up
  const during = join(r.root, 'during.sh');
  writeFileSync(during, '#!/bin/sh\ndocker info >/dev/null\n', {mode: 0o755});
  r.tick({DURING_SESSION: during});
  assert.equal(r.ran(), true);
  const h = r.dockerHost;
  assert.deepEqual(daemonSweep(r), [
    swarmState(h), `${h}|plugin ls -q`, `${h}|ps -aq`, `${h}|rm -f --volumes left-behind-db-1`, `${h}|ps -aq`,
    ...prunes(h), `${h}|ps -aq`,
    `${h}|info`,
    swarmState(h), `${h}|plugin ls -q`, `${h}|ps -aq`, `${h}|rm -f --volumes ${db}-db-1`, `${h}|ps -aq`,
    ...prunes(h), `${h}|ps -aq`,
  ]);
  assert.equal(readFileSync(join(r.root, 'docker/ps.json'), 'utf8'), '[]', 'no container is left');
  const log = r.log();
  assert.match(log, /ticket #7: swept the project's Docker daemon before the session: removed 1 container and pruned the volumes, networks, images and build cache\n.*ticket #7: run 1 of 3 starting/);
  assert.match(log, /ticket #7: swept the project's Docker daemon after the session: removed 1 container and pruned/);
});

test('the daemon sweep leaves a swarm and removes every plugin before it removes the containers', t => {
  const r = ticketSetup(t);
  r.docker.containers([['service-task', '']]);  // a task of a service a session started
  writeFileSync(join(r.root, 'docker/swarm'), 'active');
  writeFileSync(join(r.root, 'docker/plugins'), 'plugin-a\nplugin-b\n');
  r.tick();
  assert.equal(r.ran(), true);
  const h = r.dockerHost;
  assert.deepEqual(daemonSweep(r), [
    swarmState(h), `${h}|swarm leave --force`, `${h}|plugin ls -q`, `${h}|plugin rm -f plugin-a plugin-b`,
    `${h}|ps -aq`, `${h}|rm -f --volumes service-task-db-1`, `${h}|ps -aq`, ...prunes(h), `${h}|ps -aq`,
    swarmState(h), `${h}|plugin ls -q`, `${h}|ps -aq`, ...prunes(h), `${h}|ps -aq`,
  ]);
  assert.equal(readFileSync(join(r.root, 'docker/plugins'), 'utf8'), '', 'no plugin is left');
});

test('the daemon sweep removes the containers again until none is left, counting each', t => {
  const r = ticketSetup(t);
  r.docker.containers([['left-behind', '']]);
  r.docker.respawn(1);  // removing it starts a replacement once
  r.tick();
  assert.equal(r.ran(), true);
  const h = r.dockerHost;
  assert.deepEqual(daemonSweep(r).slice(0, 7), [
    swarmState(h), `${h}|plugin ls -q`, `${h}|ps -aq`, `${h}|rm -f --volumes left-behind-db-1`,
    `${h}|ps -aq`, `${h}|rm -f --volumes respawned-1-db-1`, `${h}|ps -aq`,
  ]);
  assert.match(r.log(), /ticket #7: swept the project's Docker daemon before the session: removed 2 containers and pruned/);
});

test('a daemon sweep that leaves a container on the daemon starts no session and is not counted', t => {
  const r = ticketSetup(t);
  r.docker.containers([['left-behind', '']]);
  r.docker.respawn(99);  // every removal starts a replacement
  assert.throws(() => r.tick(), error => error.status === 1);
  assert.equal(r.ran(), false);
  const h = r.dockerHost;
  assert.equal(daemonSweep(r).filter(call => call.startsWith(`${h}|rm `)).length, 5, 'five rounds of removal');
  assert.match(r.log(), /ticket #7: could not sweep the project's Docker daemon clean, so no session starts; not counted: 1 container is still on the daemon after its removal and the prunes\n/);
  assert.equal(readFileSync(join(r.root, 'state/ticket-runner/attempts/ticket-7'), 'utf8').trim(), '0');
  assert.deepEqual(r.tokenCalls(), []);
});

test('a daemon sweep after the session that leaves a container on the daemon is logged', t => {
  const r = ticketSetup(t);
  const during = join(r.root, 'during.sh');  // the session leaves a container that replaces itself
  writeFileSync(during, `#!/bin/sh\nprintf '[["left-behind",""]]' > "$PROBE/docker/ps.json"\nprintf 99 > "$PROBE/docker/respawn"\n`, {mode: 0o755});
  r.tick({DURING_SESSION: during});
  assert.equal(r.ran(), true);
  const log = r.log();
  assert.match(log, /ticket #7: could not sweep the project's Docker daemon after the session: 1 container is still on the daemon after its removal and the prunes\n/);
});

test('a daemon sweep whose swarm leave fails starts no session', t => {
  const r = ticketSetup(t);
  writeFileSync(join(r.root, 'docker/swarm'), 'error');
  writeFileSync(join(r.root, 'docker/fail-swarm-leave'), '');
  assert.throws(() => r.tick(), error => error.status === 1);
  assert.equal(r.ran(), false);
  assert.match(r.log(), /ticket #7: could not sweep the project's Docker daemon clean, so no session starts; not counted: docker swarm leave --force failed: Error response from daemon: context deadline exceeded\n/);
});

test('a project whose machine file names no rootless daemon of its own gets no daemon sweep and no docker call', t => {
  const r = ticketSetup(t);
  r.noRootlessDaemon();
  r.tick({DOCKER_HOST: 'unix:///var/run/docker.sock'});
  assert.equal(r.ran(), true);
  assert.deepEqual(r.docker.calls(), []);
  assert.doesNotMatch(r.log(), /swept|sweep the project's Docker daemon/);
});

test('a daemon sweep that fails before the session starts no session, mints no token and is not counted', t => {
  const r = ticketSetup(t);
  r.docker.refuse(r.dockerHost);
  assert.throws(() => r.tick(), error => error.status === 1);
  assert.equal(r.ran(), false);
  assert.match(r.log(), /ticket #7: could not sweep the project's Docker daemon clean, so no session starts; not counted: docker info failed: Cannot connect to the Docker daemon at unix:\/\/.*\. Is the docker daemon running\?\n/);
  assert.equal(readFileSync(join(r.root, 'state/ticket-runner/attempts/ticket-7'), 'utf8').trim(), '0');
  assert.deepEqual(r.tokenCalls(), []);
});

test('a daemon sweep that fails after the session is logged and the run still finishes', t => {
  const r = ticketSetup(t);
  const during = join(r.root, 'during.sh');  // the daemon goes down during the session
  writeFileSync(during, `#!/bin/sh\nprintf '%s' '${r.dockerHost}' > "$PROBE/docker/refuse"\n`, {mode: 0o755});
  r.gh.respond({'issue view 7': {stdout: 'yes\n'}});
  r.tick({DURING_SESSION: during});
  assert.equal(r.ran(), true);
  const log = r.log();
  assert.match(log, /ticket #7: could not sweep the project's Docker daemon after the session: docker info failed: Cannot connect to the Docker daemon/);
  assert.match(log, /ticket #7: run 1 finished \(exit 0\)/);
  assert.equal(existsSync(r.worktree), false, "the run's clone is still removed");
});

test('a project file whose docker is not true or false stops the tick', t => {
  const r = ticketSetup(t, [issue(7)], {project: project({docker: 'yes'})});
  assert.throws(() => r.tick(), error => error.status === 2
    && error.stderr.includes(`${join(r.checkout, '.triphammer/project.json')} is malformed: docker must be true or false`));
  assert.equal(r.ran(), false);
});

test("the runtime directories the write limit creates in Codex's directory land in the fixture's home", t => {
  const r = ticketSetup(t);
  r.tick();
  assert.equal(r.ran(), true);
  assert.equal(existsSync(join(r.home, '.codex/sessions')), true);
});

test('a machine where the write limit does not work starts no session and counts no run', t => {
  const r = ticketSetup(t, [issue(7)], {bin: {bwrap: '#!/bin/sh\necho "bwrap: setting up uid map: Permission denied" >&2\nexit 1\n'}});
  assert.throws(() => r.tick(), error => error.status === 1);
  assert.equal(r.ran(), false);
  assert.match(r.log(), /ticket #7: the sessions' write limit does not work here, so no session starts: bwrap: setting up uid map: Permission denied \(ticket-runner --doctor names the fix\)/);
  assert.equal(existsSync(join(r.root, 'state/ticket-runner/attempts/ticket-7')), false);
  assert.deepEqual(labelCalls(r.ghCalls()), []);
});

// Weekly upkeep.
const isoDaysAgo = days => new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const upkeepIssue = (number, days, state) =>
  ({...issue(number, {state, labels: ['upkeep']}), createdAt: isoDaysAgo(days)});

test('with no upkeep issue in the last 7 days and nothing else to do, a tick opens one and runs it', t => {
  const r = ticketSetup(t, [upkeepIssue(5, 8, 'CLOSED')]);
  const before = new Date().toISOString().slice(0, 10);
  r.tick();
  const after = new Date().toISOString().slice(0, 10);
  const creates = r.creates();
  assert.equal(creates.length, 1);
  assert.ok([`Upkeep: week of ${before}`, `Upkeep: week of ${after}`].includes(flagValue(creates[0], '--title')));
  assert.equal(flagValue(creates[0], '--label'), 'upkeep');
  assert.match(flagValue(creates[0], '--body'), /`triphammer:upkeep` skill/);
  assert.ok(r.ghCalls().some(call => call.slice(0, 3).join(' ') === 'label create upkeep'), 'the label exists');
  const args = r.probe('claude-args');
  assert.match(args, /Run issue #90 of Example-Owner\/example-project unattended/);
  assert.match(r.log(), /#90: opened Upkeep: week of/);
});

test('the stop file and a stop-agents issue stop the upkeep action', t => {
  const stopped = ticketSetup(t, []);
  mkdirSync(join(stopped.root, 'state/ticket-runner'), {recursive: true});
  writeFileSync(join(stopped.root, 'state/ticket-runner/stop'), '');
  stopped.tick();
  const paused = ticketSetup(t, []);
  paused.gh.respond({[`issue list -R ${repo} --state open --label stop-agents`]: {stdout: '99\n'}});
  paused.tick();
  for (const r of [stopped, paused]) {
    assert.deepEqual(r.creates(), []);
    assert.equal(r.ran(), false);
  }
});

test('--plan prints the upkeep action and creates nothing', t => {
  const r = ticketSetup(t, []);
  assert.equal(r.tick({}, ['--plan']).trim(), 'upkeep');
  assert.deepEqual(r.creates(), []);
  assert.ok(!r.ghCalls().some(call => call[0] === 'label'));
  assert.equal(r.ran(), false);
});

test('an upkeep run that closes its issue is not a run without progress; one that leaves it open is', t => {
  const closes = ticketSetup(t, []);
  mkdirSync(join(closes.root, 'state/ticket-runner/attempts'), {recursive: true});
  writeFileSync(closes.attemptsFile, '2\n');  // as if two runs had already ended without progress
  closes.gh.respond({'issue view 90': {stdout: 'yes\n'}});
  closes.tick();
  assert.match(closes.log(), /ticket #90: run 3 finished/);
  assert.equal(existsSync(closes.attemptsFile), false);
  assert.ok(!closes.ghCalls().some(call => call.includes('--add-label') && call.includes('needs-owner')), 'no needs-owner');

  const open = ticketSetup(t, []);
  mkdirSync(join(open.root, 'state/ticket-runner/attempts'), {recursive: true});
  writeFileSync(open.attemptsFile, '2\n');
  open.tick();
  assert.match(open.log(), /ticket #90: run 3 ended without progress/);
  assert.ok(open.ghCalls().some(call => call.join(' ') === `issue edit 90 -R ${repo} --add-label needs-owner`));
});

// The progress check after a run: an open pull request GitHub links as closing the issue (closingIssuesReferences).

const linked = (owner, name, number) =>
  ({number: 70, body: '', closingIssuesReferences: [{id: 'I_1', number, url: `https://github.com/${owner}/${name}/issues/${number}`,
    repository: {id: 'R_1', name, owner: {id: 'U_1', login: owner}}}]});
function tickOpening(t, opened) {
  const r = ticketSetup(t);
  writeFileSync(join(r.root, 'opened.json'), JSON.stringify(opened));
  r.tick();
  return r;
}

test('a run that opened a pull request GitHub links to the issue made progress, in this repository whatever the case', t => {
  for (const [owner, name] of [['Example-Owner', 'example-project'], ['example-owner', 'example-project']]) {
    const r = tickOpening(t, [linked(owner, name, 7)]);
    assert.match(r.log(), /ticket #7: run 1 finished/, `${owner}/${name}`);
    assert.equal(existsSync(r.worktree), false);
    assert.ok(!r.ghCalls().some(call => call.slice(0, 2).join(' ') === 'issue comment'), 'no "no progress" comment');
  }
});

test("a run whose only pull request closes another repository's #N, or a different issue, made no progress", t => {
  for (const opened of [[linked('other', 'repo', 7)], [linked('Example-Owner', 'example-project', 77)],
    [{number: 70, body: 'Closes #7', closingIssuesReferences: []}]]) {
    const r = tickOpening(t, opened);
    assert.match(r.log(), /ticket #7: run 1 ended without progress/, JSON.stringify(opened));
  }
});

// The security review after the session (bin/security-review).

test('after the session and its demos the runner security-reviews the pull request the session opened', t => {
  const r = tickOpening(t, [linked('Example-Owner', 'example-project', 7)]);
  assert.deepEqual(r.securityCalls(), [`--pr 70 --repo ${r.checkout}`]);
  const log = r.log();
  assert.match(log, /ticket #7: security review of #70: the session had run\n/);
  assert.ok(log.indexOf('demo risk-journey') < log.indexOf('security review of #70'), 'after the demos are published');
});

test('a ticket run with no pull request closing its issue runs no security review', t => {
  const r = tickOpening(t, [linked('Example-Owner', 'example-project', 77)]);
  assert.deepEqual(r.securityCalls(), []);
});

test('a failed security review is logged and the run carries on', t => {
  const r = ticketSetup(t);
  writeFileSync(join(r.root, 'opened.json'), JSON.stringify([linked('Example-Owner', 'example-project', 7)]));
  r.tick({SECURITY_FAIL: '1'});
  const log = r.log();
  assert.match(log, /ticket #7: security review of #70: gh: network down\n/);
  assert.match(log, /ticket #7: security review of #70 failed\n/);
  assert.match(log, /ticket #7: run 1 finished/);
});

// The Triphammer config's optional modules (bin/README.md, "Configuration").

// A ticket run whose session opens pull request #70, closing #7, with `modules` as the config's MODULES (null for none).
function tickWithModules(t, modules) {
  const r = ticketSetup(t, [issue(7)], {config: {MODULES: modules}});
  writeFileSync(join(r.root, 'opened.json'), JSON.stringify([linked('Example-Owner', 'example-project', 7)]));
  r.tick();
  return r;
}

test('with every module off a ticket run publishes no demo, reviews nothing, and logs nothing about either', t => {
  for (const modules of [null, '']) {
    const r = tickWithModules(t, modules);
    assert.deepEqual(r.reindexCalls(), [], 'no gallery reindex');
    assert.deepEqual(r.demoCalls(), [], 'no publish');
    assert.deepEqual(r.securityCalls(), [], 'no security review');
    const log = r.log();
    assert.match(log, /ticket #7: run 1 finished/, 'the pull request still counts as progress');
    assert.doesNotMatch(log, /demo|gallery|publish|security|review/i);
    assert.match(r.probe('claude-args'), /This is run 1 of 3\. Brief triphammer:builder for every builder\. No module is on\. Follow/);
  }
});

test('with one module on, only its steps run, and the session prompt names it', t => {
  const demo = tickWithModules(t, 'demo');
  assert.deepEqual(demo.reindexCalls(), ['reindex']);
  assert.equal(demo.demoCalls().length, 1);
  assert.deepEqual(demo.securityCalls(), []);
  assert.doesNotMatch(demo.log(), /security/i);
  assert.match(demo.probe('claude-args'), /Modules on: demo\. Follow/);

  const codex = tickWithModules(t, 'codex');
  assert.deepEqual(codex.reindexCalls(), []);
  assert.deepEqual(codex.demoCalls(), []);
  assert.deepEqual(codex.securityCalls(), [`--pr 70 --repo ${codex.checkout}`]);
  assert.doesNotMatch(codex.log(), /demo|gallery|publish/i);
  assert.match(codex.probe('claude-args'), /Modules on: codex\. Follow/);

  const qwen = tickWithModules(t, 'qwen-audit');
  assert.deepEqual(qwen.reindexCalls(), []);
  assert.deepEqual(qwen.demoCalls(), []);
  assert.deepEqual(qwen.securityCalls(), []);
  assert.doesNotMatch(qwen.log(), /demo|gallery|publish|security|review/i);
  assert.match(qwen.probe('claude-args'), /Modules on: qwen-audit\. Follow/);

  const all = tickWithModules(t, 'codex,demo,qwen-audit');
  assert.match(all.probe('claude-args'), /Modules on: codex, demo, qwen-audit\. Follow/);
});

test('a repair prompt names the modules too', t => {
  const r = repairSetup(t);
  r.tick();
  assert.match(r.probe('claude-args'), /This is run 1 of 3\. Brief triphammer:builder for every builder\. Modules on: demo, codex\. Follow the 'Repair a pull request' section/);
});

test('a repair prompt names the owner, the owner part of REPO by default and OWNER when the config sets it', t => {
  const r = repairSetup(t);
  r.tick();
  assert.match(r.probe('claude-args'), /reason conflicts\. The owner is Example-Owner\. You are/);
  const set = repairSetup(t, {config: {OWNER: 'example-person'}});
  set.tick();
  assert.match(set.probe('claude-args'), /reason conflicts\. The owner is example-person\. You are/);
});

// The owner the runner acts for (the config's OWNER), in a repository an organization owns.
const org = 'Example-Org/example-project';
const byPerson = number => ({...issue(number), author: {is_bot: false, login: 'example-person'}});

test('with OWNER unset in a repository an organization owns, the runner refuses to plan and names the setting', t => {
  const r = ticketSetup(t, [byPerson(7)], {served: org, config: {REPO: org}});
  r.gh.respond({'api users/Example-Org': {stdout: 'Organization\n'}});
  for (const args of [['--plan'], []]) {
    assert.throws(() => r.tick({}, args), error => error.status === 2
      && error.stderr.includes(`Example-Org, the owner part of REPO, is an organization; set OWNER in ${r.configFile}`));
  }
  assert.ok(!r.ghCalls().some(call => call.includes('number,state,author,body,labels,createdAt')), 'it reads no issue list');
  assert.equal(r.ran(), false);
});

test('OWNER set to a person is the owner the runner plans for, in a repository an organization owns', t => {
  const r = ticketSetup(t, [byPerson(7)], {served: org, config: {REPO: org, OWNER: 'example-person'}});
  r.gh.respond({'api users/Example-Org': {stdout: 'Organization\n'}});
  assert.equal(r.tick({}, ['--plan']).trim(), 'ticket 7');
  assert.ok(r.ghCalls().some(call => call.join(' ') === 'api users/example-person --jq .type'));
});

test('OWNER set to an organization, or an owner GitHub cannot look up, refuses to plan', t => {
  const org1 = ticketSetup(t, [byPerson(7)], {served: org, config: {REPO: org, OWNER: 'Example-Org'}});
  org1.gh.respond({'api users/Example-Org': {stdout: 'Organization\n'}});
  assert.throws(() => org1.tick({}, ['--plan']), error => error.status === 2
    && error.stderr.includes(`OWNER in ${org1.configFile} is Example-Org, an organization`));
  const lost = ticketSetup(t, [byPerson(7)], {config: {OWNER: 'example-person'}});
  lost.gh.respond({'api users/': {stderr: 'gh: network down\n', exit: 1}});
  assert.throws(() => lost.tick({}, ['--plan']), error => error.status === 1
    && error.stderr.includes('could not look up the owner, example-person, on GitHub; not planning'));
});

test("the session's environment carries the owner as TRIPHAMMER_OWNER, the login land-pr requests a review from", t => {
  const r = ticketSetup(t);
  r.tick({TRIPHAMMER_OWNER: 'stale-login'});
  assert.equal(r.probe('triphammer-owner'), 'Example-Owner', 'OWNER unset: the owner part of REPO');
  const set = ticketSetup(t, [byPerson(7)], {served: org, config: {REPO: org, OWNER: 'example-person'}});
  set.gh.respond({'api users/Example-Org': {stdout: 'Organization\n'}});
  set.tick({TRIPHAMMER_OWNER: 'stale-login'});
  assert.equal(set.probe('triphammer-owner'), 'example-person', 'OWNER set: that login, not the organization');
});

test("on a personal repository with OWNER unset, the runner looks up REPO's owner and takes that owner's issues", t => {
  const r = ticketSetup(t, [{...issue(7), author: {is_bot: false, login: 'Example-Owner'}}]);
  assert.equal(r.tick({}, ['--plan']).trim(), 'ticket 7');
  assert.ok(r.ghCalls().some(call => call.join(' ') === 'api users/Example-Owner --jq .type'));
});

// The `current` file merge-when-ready reads while the runner holds its lock.

// The `key value` lines of a current file.
const currentFields = text => Object.fromEntries(text.split('\n').filter(Boolean).map(line => {
  const at = line.indexOf(' ');
  return [line.slice(0, at), line.slice(at + 1)];
}));

test('a ticket run writes current before the session starts and removes it after the session ends', t => {
  const r = ticketSetup(t);
  r.tick();
  const {pid, started, ...run} = currentFields(r.probe('current'));
  assert.match(pid, /^\d+$/);
  assert.equal(r.probe('holder-lock'), `${join(r.root, 'state/ticket-runner/lock')}\n`, 'it names the process holding the lock');
  assert.equal(r.probe('holder-started'), `${started}\n`, 'with that process\'s start time');
  assert.deepEqual(run, {kind: 'ticket', number: '7', branch: 'ticket/7', prs: ''});
  assert.equal(existsSync(r.current), false);
});

test('a run that fails after the session still removes current', t => {
  const r = ticketSetup(t);
  r.gh.respond({'issue view 7': {stderr: 'gh: network down\n', exit: 1}});
  assert.throws(() => r.tick());
  assert.equal(currentFields(r.probe('current')).kind, 'ticket', 'it was written for the session');
  assert.equal(existsSync(r.current), false);
});

// A machine whose next tick repairs pull request #40 (branch ticket/30, which closes #30) for its conflicts; `options` go to
// ticketSetup.
function repairSetup(t, options = {}) {
  const r = ticketSetup(t, [issue(30)], options);
  const publisher = join(r.root, 'publisher');
  git(publisher, 'checkout', '-q', '-b', 'ticket/30');
  git(publisher, 'push', '-q', 'origin', 'ticket/30');
  r.gh.json('pulls.json', [{
    number: 40, author: {login: 'app/example-agents'}, isDraft: false, labels: [], mergeStateStatus: 'DIRTY',
    statusCheckRollup: [], reviews: [], commits: [], closingIssuesReferences: [{number: 30,
      repository: {name: 'example-project', owner: {login: 'Example-Owner'}}}],
  }]);
  r.gh.respond({[`pr view 40 -R ${repo} --json headRefName`]: {stdout: 'ticket/30\n'}});
  return r;
}

test('a repair run names the pull request it repairs in current', t => {
  const r = repairSetup(t);
  r.tick();
  const {kind, number, branch, prs} = currentFields(r.probe('current'));
  assert.deepEqual({kind, number, branch, prs}, {kind: 'repair', number: '40', branch: 'ticket/30', prs: '40'});
  assert.equal(existsSync(r.current), false);
  assert.deepEqual(r.securityCalls(), [`--pr 40 --repo ${r.checkout}`], 'the repaired pull request is security-reviewed');
});

// A machine whose next tick repairs pull request #40 for the security findings recorded on its head; `options` go to
// ticketSetup.
const findingsHead = 'c'.repeat(40);
const findingsLine = `${repo} 40 ${findingsHead}`;
function securityRepairSetup(t, options = {}) {
  const r = repairSetup(t, options);
  r.gh.json('pulls.json', [{...JSON.parse(readFileSync(join(r.root, 'gh/pulls.json'), 'utf8'))[0],
    mergeStateStatus: 'CLEAN', headRefOid: findingsHead}]);
  const state = join(r.root, 'state/ticket-runner');
  mkdirSync(state, {recursive: true});
  writeFileSync(join(state, 'security-findings'), `${findingsLine}\n`);
  const followedUp = join(state, 'security-followed-up');
  return {...r, followedUp: () => lines(followedUp),
    attempts: join(state, 'attempts/repair-40')};
}

test('a security-findings repair session that ends normally records its head as followed up, and made progress', t => {
  const r = securityRepairSetup(t);
  r.tick();
  assert.match(r.probe('claude-args'), /reason security-findings/);
  const list = r.ghCalls().find(call => call[0] === 'pr' && call[1] === 'list' && call.some(arg => arg.includes('reviews')));
  assert.match(flagValue(list, '--json'), /(^|,)headRefOid(,|$)/, 'the decision reads each head');
  assert.deepEqual(r.followedUp(), [findingsLine]);
  assert.match(r.log(), /repair #40: run 1 finished \(exit 0\)/, 'answering in a comment, with the head unchanged, is progress');
  assert.equal(existsSync(r.attempts), false);
  assert.equal(r.ghCalls().some(call => call.join(' ').includes('--add-label hold')), false);
  assert.doesNotMatch(r.tick({}, ['--plan']), /^repair/, 'the followed-up head is not repaired again');
});

test('a failed, timed-out or rate-limited security-findings repair session records no follow-up', t => {
  for (const env of [{CLAUDE_EXIT: '1'}, {CLAUDE_EXIT: '124'}, {CLAUDE_EXIT: '1', CLAUDE_SAYS: 'Claude usage limit reached'}]) {
    const r = securityRepairSetup(t);
    r.tick(env);
    assert.deepEqual(r.followedUp(), [], JSON.stringify(env));
  }
});

test('a repair for another reason records no security follow-up', t => {
  const r = securityRepairSetup(t);
  r.gh.json('pulls.json', [{...JSON.parse(readFileSync(join(r.root, 'gh/pulls.json'), 'utf8'))[0], mergeStateStatus: 'DIRTY'}]);
  r.tick();
  assert.match(r.probe('claude-args'), /reason conflicts/);
  assert.deepEqual(r.followedUp(), []);
});

test('during the security review current still names the live runner but none of its pull requests or its branch', t => {
  const r = ticketSetup(t, [{number: 30, state: 'OPEN', body: '', labels: []}]);
  const publisher = join(r.root, 'publisher');
  git(publisher, 'checkout', '-q', '-b', 'ticket/30');
  git(publisher, 'push', '-q', 'origin', 'ticket/30');
  r.gh.json('pulls.json', [{
    number: 40, author: {login: 'app/example-agents'}, isDraft: false, labels: [], mergeStateStatus: 'DIRTY',
    statusCheckRollup: [], reviews: [], commits: [], closingIssuesReferences: [{number: 30,
      repository: {name: 'example-project', owner: {login: 'Example-Owner'}}}],
  }]);
  r.gh.respond({[`pr view 40 -R ${repo} --json headRefName`]: {stdout: 'ticket/30\n'}});
  r.tick();
  const session = currentFields(r.probe('current'));
  const review = currentFields(r.probe('review-current'));
  assert.deepEqual(r.securityCalls(), [`--pr 40 --repo ${r.checkout}`]);
  assert.deepEqual({pid: review.pid, started: review.started, kind: review.kind, number: review.number},
    {pid: session.pid, started: session.started, kind: 'repair', number: '40'}, 'merge-when-ready still sees the live runner');
  assert.equal(review.prs, '', 'merge-when-ready may update the reviewed pull request');
  assert.notEqual(review.branch, 'ticket/30', 'nor matches it by its branch');
  assert.match(review.branch, /^[A-Za-z0-9._/-]+$/, 'merge-when-ready can still read the file');
  assert.equal(existsSync(r.current), false);
});

// The `agent-working` label on the run's own issue or pull request.

const labelCalls = calls => calls.map(call => call.join(' ')).filter(call => call.includes('agent-working') && call.includes(' edit '));
const labelCallsAtSession = r => labelCalls(lines(join(r.root, 'calls-at-session')).map(line => JSON.parse(line)));

test('a ticket run labels its issue agent-working while the session runs, and never the pull request it opens', t => {
  const r = ticketSetup(t);
  writeFileSync(join(r.root, 'opened.json'), JSON.stringify([linked('Example-Owner', 'example-project', 7)]));
  r.tick();
  assert.deepEqual(labelCallsAtSession(r), [`issue edit 7 -R ${repo} --add-label agent-working`]);
  assert.deepEqual(labelCalls(r.ghCalls()),
    [`issue edit 7 -R ${repo} --add-label agent-working`, `issue edit 7 -R ${repo} --remove-label agent-working`]);
  assert.match(r.log(), /issue #7: added agent-working[^]*ticket #7: run 1 finished[^]*issue #7: removed agent-working/);
});

test('a repair run labels its pull request agent-working while the session runs', t => {
  const r = repairSetup(t);
  r.tick();
  assert.deepEqual(labelCallsAtSession(r), [`pr edit 40 -R ${repo} --add-label agent-working`]);
  assert.deepEqual(labelCalls(r.ghCalls()),
    [`pr edit 40 -R ${repo} --add-label agent-working`, `pr edit 40 -R ${repo} --remove-label agent-working`]);
  assert.match(r.log(), /pr #40: added agent-working[^]*pr #40: removed agent-working/);
});

test('the label comes off after a failing session, a usage limit, a timeout and a failure after the session', t => {
  const cases = [
    [{CLAUDE_EXIT: '1'}, /run 1 ended without progress \(exit 1\)/],
    [{CLAUDE_EXIT: '1', CLAUDE_SAYS: 'Claude usage limit reached'}, /stopped by a usage or rate limit/],
    [{CLAUDE_EXIT: '124'}, /run 1 ended without progress \(exit 124\)/],
  ];
  for (const [env, ending] of cases) {
    const r = ticketSetup(t);
    r.tick(env);
    assert.match(r.log(), ending, JSON.stringify(env));
    assert.deepEqual(labelCalls(r.ghCalls()).slice(-1), [`issue edit 7 -R ${repo} --remove-label agent-working`]);
  }
  const r = ticketSetup(t);
  r.gh.respond({'issue view 7': {stderr: 'gh: network down\n', exit: 1}});
  assert.throws(() => r.tick());
  assert.deepEqual(labelCalls(r.ghCalls()).slice(-1), [`issue edit 7 -R ${repo} --remove-label agent-working`]);
});

test('a runner stopped while it adds agent-working still removes current and the label', t => {
  // The service is stopped (SIGTERM to the runner named in `current`) while the gh call that adds the label runs.
  const r = ticketSetup(t, [issue(7)], {bin: {gh: `#!/bin/sh
case "$*" in *"--add-label agent-working"*) kill -TERM "$(sed -n 's/^pid //p' "$XDG_STATE_HOME/ticket-runner/current")";; esac
exec '${process.execPath}' '${join(here, 'fake-gh.mjs')}' "$XDG_STATE_HOME/../gh" "$@"
`}});
  assert.throws(() => r.tick(), error => error.status === 143);
  assert.equal(r.ran(), false);
  assert.equal(existsSync(r.current), false);
  assert.deepEqual(labelCalls(r.ghCalls()),
    [`issue edit 7 -R ${repo} --add-label agent-working`, `issue edit 7 -R ${repo} --remove-label agent-working`]);
});

test("a tick removes stale agent-working labels from issues and pull requests before it starts its own run", t => {
  const r = ticketSetup(t);
  r.gh.respond({
    [`issue list -R ${repo} --state all --label agent-working`]: {stdout: '12\n13\n'},
    [`pr list -R ${repo} --state all --label agent-working`]: {stdout: '40\n'},
  });
  r.tick();
  assert.deepEqual(labelCallsAtSession(r), [
    `issue edit 12 -R ${repo} --remove-label agent-working`,
    `issue edit 13 -R ${repo} --remove-label agent-working`,
    `pr edit 40 -R ${repo} --remove-label agent-working`,
    `issue edit 7 -R ${repo} --add-label agent-working`,
  ]);
  const log = r.log();
  for (const removed of ['issue #12', 'issue #13', 'pr #40']) assert.match(log, new RegExp(`${removed}: removed agent-working`));
});

test('the stale sweep is not run by --plan', t => {
  const r = ticketSetup(t);
  r.gh.respond({[`issue list -R ${repo} --state all --label agent-working`]: {stdout: '12\n'}});
  r.tick({}, ['--plan']);
  assert.deepEqual(labelCalls(r.ghCalls()), []);
});

test('failed agent-working calls are logged and stop neither the tick nor the run', t => {
  const r = ticketSetup(t);
  r.gh.respond({
    [`issue list -R ${repo} --state all --label agent-working`]: {stderr: 'gh: HTTP 502\n', exit: 1},
    [`pr list -R ${repo} --state all --label agent-working`]: {stdout: '40\n'},
    [`pr edit 40 -R ${repo} --remove-label`]: {stderr: 'gh: HTTP 502\n', exit: 1},
    [`issue edit 7 -R ${repo} --add-label agent-working`]: {stderr: 'gh: label not found\n', exit: 1},
    [`issue edit 7 -R ${repo} --remove-label agent-working`]: {stderr: 'gh: label not found\n', exit: 1},
    'issue view 7': {stdout: 'yes\n'},
  });
  r.tick();
  assert.ok(r.ran(), 'the session ran');
  const log = r.log();
  assert.match(log, /could not list issues labelled agent-working/);
  assert.match(log, /pr #40: could not remove agent-working: gh: HTTP 502/);
  assert.match(log, /issue #7: could not add agent-working: gh: label not found/);
  assert.match(log, /ticket #7: run 1 finished/);
  assert.match(log, /issue #7: could not remove agent-working: gh: label not found/);
});

// The sweep each tick: run directories no run will use again, and databases whose run directory is gone.

// The example project's scripts/local-db.sh's project name for a run directory.
const localDb = worktree =>
  `example-project-local-${run('sh', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', 'sh', worktree]).trim()}`;
const recentUpkeep = upkeepIssue(1, 1, 'CLOSED');  // with it and no ready issue, a tick does nothing else
const held = number => issue(number, {labels: ['hold']});
const closed = number => issue(number, {state: 'CLOSED'});

// A machine with run clones in .worktrees, as ticket-runner makes them, issue-11 (closed), issue-12 (open, one run
// used), issue-13 (open, three runs used), issue-14 (open, with an open pull request), issue-15 (closed, but the
// `current` file names it), issue-16 (open, never run) and pr-21 (open), git worktrees there pr-20 (merged) and the
// manual demo-specs, a symlink issue-17 (closed) to a directory outside, and a git worktree outside .worktrees named
// issue-18 (closed).
function sweepSetup(t) {
  const r = ticketSetup(t, [recentUpkeep, closed(11), held(12), held(13), held(14), closed(15), held(16), closed(17),
    closed(18)]);
  r.gh.json('pulls.json', [{...linked('Example-Owner', 'example-project', 14), author: {login: 'someone'}, isDraft: false,
    labels: [], mergeStateStatus: 'CLEAN', statusCheckRollup: [], reviews: [], commits: []}]);
  r.gh.respond({
    [`pr view 20 -R ${repo} --json state`]: {stdout: 'MERGED\n'},
    [`pr view 21 -R ${repo} --json state`]: {stdout: 'OPEN\n'},
  });
  const worktree = name => join(r.checkout, '.worktrees', name);
  for (const name of ['issue-11', 'issue-12', 'issue-13', 'issue-14', 'issue-15', 'issue-16', 'pr-21'])
    runClone(r.checkout, join(r.root, 'origin.git'), worktree(name));
  for (const name of ['pr-20', 'demo-specs'])
    git(r.checkout, 'worktree', 'add', '-q', '-b', `b/${name}`, worktree(name), 'origin/main');
  const outside = join(r.root, 'outside-17');
  mkdirSync(outside);
  writeFileSync(join(outside, 'kept.txt'), 'kept\n');
  symlinkSync(outside, worktree('issue-17'));
  git(r.checkout, 'worktree', 'add', '-q', '-b', 'b/issue-18', join(r.root, 'issue-18'), 'origin/main');
  const state = join(r.root, 'state/ticket-runner');
  mkdirSync(join(state, 'attempts'), {recursive: true});
  writeFileSync(join(state, 'attempts/ticket-12'), '1\n');
  writeFileSync(join(state, 'attempts/ticket-13'), '3\n');
  writeFileSync(join(state, 'current'), 'pid 1\nstarted 1\nkind ticket\nnumber 15\nbranch ticket/15\nprs \n');
  return {...r, worktree, outside, runs: () => readdirSync(join(r.checkout, '.worktrees')).sort(),
    worktrees: () => git(r.checkout, 'worktree', 'list', '--porcelain')
      .split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))};
}

test('a tick removes the run directories no run will use again, stopping their databases first', t => {
  const r = sweepSetup(t);
  r.docker.containers([[localDb(r.worktree('issue-11')), join(r.worktree('issue-11'), 'database')]]);
  r.tick();
  const log = r.log();
  for (const [name, reason] of [['issue-11', 'issue #11 is closed'], ['issue-13', 'issue #13 used all 3 runs'],
    ['issue-14', 'issue #14 has an open pull request'], ['pr-20', 'pull request #20 is merged']]) {
    assert.equal(existsSync(r.worktree(name)), false, name);
    assert.ok(log.includes(`removed run directory ${r.worktree(name)} (${reason})\n`), name);
  }
  assert.match(log, new RegExp(`tore down ${r.worktree('issue-11')}: .*Removed\n`));
  assert.ok(!log.includes(`tore down ${r.worktree('issue-13')}`), 'a teardown that prints nothing is not logged');
  assert.deepEqual(r.runs(), ['demo-specs', 'issue-12', 'issue-15', 'issue-16', 'issue-17', 'pr-21'],
    'the current run, open issues under their runs, an open PR, a manual worktree and a symlink stay');
  assert.deepEqual(r.worktrees().sort(), [r.checkout, r.worktree('demo-specs'), join(r.root, 'issue-18')].sort(),
    "the merged pull request's worktree is gone from git's list too");
  assert.equal(readFileSync(join(r.outside, 'kept.txt'), 'utf8'), 'kept\n', 'nothing outside .worktrees is touched');
  assert.doesNotMatch(log, /issue-17|issue-18/);
  assert.equal(r.ran(), false);
});

test('a run left behind, by a run without progress or a killed tick, is removed once its issue closes, its database first', t => {
  const r = ticketSetup(t);
  const db = localDb(r.worktree);
  writeFileSync(join(r.root, 'session-db.json'), JSON.stringify([[db, join(r.worktree, 'database')]]));  // local-db.sh up
  r.tick();
  assert.match(r.log(), /ticket #7: run 1 ended without progress/);
  assert.equal(existsSync(join(r.worktree, '.git/objects/info/alternates')), true, "the run's clone is left");
  r.gh.json('issues.json', [recentUpkeep, closed(7)]);
  r.tick();
  assert.ok(r.docker.calls().some(call => call.startsWith(`${db}|compose --file `) && call.endsWith(' down --volumes --remove-orphans')));
  assert.match(r.log(), new RegExp(`removed run directory ${r.worktree} \\(issue #7 is closed\\)\n`));
  assert.equal(existsSync(r.worktree), false);
});

test('a failed removal is logged and the tick carries on', t => {
  const r = sweepSetup(t);
  const locked = join(r.worktree('issue-11'), 'locked');
  mkdirSync(locked);
  writeFileSync(join(locked, 'file'), '');
  git(r.checkout, 'worktree', 'lock', r.worktree('pr-20'));  // `worktree remove --force` refuses a locked one
  r.docker.containers([['example-project-local-1', join(r.root, 'gone/database')]]);
  chmodSync(locked, 0o555);  // rm -rf cannot remove the file in it
  try {
    r.tick();
  } finally {
    chmodSync(locked, 0o755);  // so the test's directory can be removed
  }
  const log = r.log();
  assert.match(log, new RegExp(`could not remove run directory ${r.worktree('issue-11')} \\(issue #11 is closed\\): .*Permission denied`));
  assert.match(log, new RegExp(`could not remove run directory ${r.worktree('pr-20')} \\(pull request #20 is merged\\): .*unlock`));
  assert.equal(existsSync(locked), true);
  assert.equal(existsSync(r.worktree('pr-20')), true);
  assert.equal(existsSync(r.worktree('issue-13')), false);
  assert.match(log, /pruned database example-project-local-1 /);
});

test('a tick prunes the databases whose run directory is gone and never one whose directory exists', t => {
  const r = ticketSetup(t, [recentUpkeep]);
  const kept = join(r.checkout, '.worktrees/demo-specs');
  mkdirSync(join(kept, 'database'), {recursive: true});
  mkdirSync(join(r.checkout, '.worktrees/no-database-dir'));
  r.docker.containers([
    ['example-project-local-1', join(r.root, 'issue-561/database')],
    ['example-project-it-2', join(r.root, 'issue-525/database')],
    ['example-project-local-3', join(kept, 'database')],
    ['example-project-local-4', ''],
    ['example-project-local-6', join(r.checkout, '.worktrees/no-database-dir/database')],
    ['example-project-local-5', join(r.root, 'gone/database')],
    ['example-project-local-5', join(kept, 'database')],
    ['example-model', join(r.root, 'gone/example-model')],
  ]);
  r.docker.failDown('example-project-it-2');
  r.tick();
  const log = r.log();
  assert.ok(log.includes(`pruned database example-project-local-1 (run directory ${join(r.root, 'issue-561')} is gone)\n`));
  assert.ok(log.includes(`could not prune database example-project-it-2 (run directory ${join(r.root, 'issue-525')} is gone): Error response`));
  const downs = r.docker.calls().filter(call => call.includes(' down '));
  assert.deepEqual(downs, ['example-project-it-2', 'example-project-local-1']
    .map(project => `|compose -p ${project} down --volumes --remove-orphans`));
  assert.doesNotMatch(log, /local-3|local-4|local-5|local-6|example-model/);
  const sweep = r.docker.hosts().filter(call => /\|(ps|compose -p)/.test(call));
  assert.ok(sweep.length > 0 && sweep.every(call => call.startsWith(`${r.dockerHost}|`)),
    `the sweep asks the rootless daemon: ${sweep.join('\n')}`);
});

test('on a machine whose machine file names no rootless daemon the database sweep is skipped with one log line', t => {
  const r = ticketSetup(t, [recentUpkeep]);
  r.noRootlessDaemon();
  r.docker.containers([['example-project-local-1', join(r.root, 'issue-561/database')]]);
  r.tick({DOCKER_HOST: 'unix:///var/run/docker.sock'});
  assert.equal(r.log().match(/database sweep skipped: the machine file names no rootless Docker daemon of this project \(run sudo triphammer update\)/g).length, 1);
  assert.deepEqual(r.docker.calls(), []);
});

test('with Docker unavailable the database sweep is skipped with one log line, and the daemon sweep starts no session', t => {
  const r = ticketSetup(t);
  r.docker.unavailable();
  assert.throws(() => r.tick(), error => error.status === 1);
  const log = r.log();
  assert.equal(log.match(/database sweep skipped: docker is unavailable/g).length, 1);
  assert.match(log, /ticket #7: could not sweep the project's Docker daemon clean, so no session starts; not counted: docker info failed: Cannot connect to the Docker daemon/);
  assert.equal(r.ran(), false);
  assert.equal(readFileSync(join(r.root, 'state/ticket-runner/attempts/ticket-7'), 'utf8').trim(), '0');
  assert.deepEqual(labelCalls(r.ghCalls()).slice(-1), [`issue edit 7 -R ${repo} --remove-label agent-working`]);
});

test('--prune-dry-run prints what the sweep would remove, changes nothing and runs nothing', t => {
  const r = sweepSetup(t);
  r.docker.containers([['example-project-local-1', join(r.root, 'issue-561/database')],
    ['example-project-local-3', join(r.worktree('demo-specs'), 'database')]]);
  mkdirSync(join(r.worktree('demo-specs'), 'database'));
  const before = [r.runs(), r.worktrees()];
  const out = r.tick({}, ['--prune-dry-run']);
  assert.deepEqual(out.split('\n').filter(Boolean), [
    `would remove run directory ${r.worktree('issue-11')} (issue #11 is closed)`,
    `would remove run directory ${r.worktree('issue-13')} (issue #13 used all 3 runs)`,
    `would remove run directory ${r.worktree('issue-14')} (issue #14 has an open pull request)`,
    `would remove run directory ${r.worktree('pr-20')} (pull request #20 is merged)`,
    `would prune database example-project-local-1 (run directory ${join(r.root, 'issue-561')} is gone)`,
  ]);
  assert.deepEqual([r.runs(), r.worktrees()], before);
  assert.deepEqual(r.docker.calls().filter(call => !call.includes('|ps ')), []);
  assert.equal(existsSync(join(r.root, 'state/ticket-runner/log')), false);
  assert.ok(!r.ghCalls().some(call => !['list', 'view'].includes(call[1])), 'gh only reads');
  assert.equal(r.ran(), false);
});

const mode = path => statSync(path).mode & 0o777;

test('the state directory, its runs, the transcripts and the run records are private to the service user, even when they existed as 755', t => {
  withUmask(t, 0o022);  // as a shell outside systemd would start the script
  const r = ticketSetup(t);
  const state = join(r.root, 'state/ticket-runner');
  mkdirSync(join(state, 'runs'), {recursive: true, mode: 0o755});
  chmodSync(state, 0o755);
  chmodSync(join(state, 'runs'), 0o755);
  r.tick();
  for (const dir of [state, join(state, 'runs'), join(state, 'attempts')]) assert.equal(mode(dir), 0o700, dir);
  const runs = readdirSync(join(state, 'runs')).sort();
  assert.deepEqual(runs.map(file => file.slice(file.indexOf('.'))), ['.json', '.jsonl'], 'a record and a transcript');
  for (const file of [join(state, 'log'), ...runs.map(name => join(state, 'runs', name))]) assert.equal(mode(file) & 0o077, 0, file);
});

// The Triphammer config and the project file (bin/README.md, "Configuration").

const realGit = realCommand('git');
// Puts a `git` first on the machine's PATH that records each call's working directory and arguments before running the real
// one; `calls` lists them as {dir, args}, where dir is the -C directory when the call names one.
function recordGit(r) {
  const file = join(r.root, 'git-calls');
  writeFileSync(join(r.gh.bin, 'git'), `#!/bin/sh
{ printf '%s' "$PWD"; for arg in "$@"; do printf '\\037%s' "$arg"; done; echo; } >> '${file}'
exec '${realGit}' "$@"
`, {mode: 0o755});
  return () => lines(file).map(line => {
    const [cwd, ...args] = line.split('\x1f');
    return {dir: args[0] === '-C' ? args[1] : cwd, args};
  });
}
const project = fields => `${JSON.stringify({name: 'example-project', ...fields}, null, 2)}\n`;
const example = JSON.parse(projectJson);
const without = (...keys) => project(Object.fromEntries(Object.entries(example).filter(([key]) => !keys.includes(key))));
const inside = (dir, root) => dir === root || dir.startsWith(`${root}/`);

test('a ticket runs on the repository, checkout, App author and state directory the config names, and no other', t => {
  const served = 'acme/widgets';
  const r = ticketSetup(t, [issue(7), {...issue(8), author: {is_bot: true, login: 'app/widget-bot'}}], {served});
  // The runner runs from r.checkout, and the config names another clone of the same origin as the main checkout.
  const checkout = join(r.root, 'other');
  git(r.root, 'clone', '-q', join(r.root, 'origin.git'), checkout);
  const state = join(r.root, 'elsewhere');
  writeConfig(r.configFile, {REPO: served, CHECKOUT: checkout, APP_AUTHOR: 'app/widget-bot', STATE_DIR: state});
  writeFileSync(join(r.root, 'opened.json'), JSON.stringify([linked('acme', 'widgets', 8)]));
  const gitCalls = recordGit(r);
  r.tick();

  assert.match(r.probe('claude-args'), /^Run issue #8 of acme\/widgets unattended/m, 'the App author picks #8, not #7');
  const ghCalls = r.ghCalls();
  assert.ok(ghCalls.some(call => call.join(' ') === `issue edit 8 -R ${served} --add-label agent-working`));
  // The owner lookup is the one call about an account rather than the repository: the owner part of REPO.
  assert.ok(ghCalls.some(call => call.join(' ') === 'api users/acme --jq .type'));
  for (const call of ghCalls.filter(call => !(call[0] === 'api' && call[1].startsWith('users/')))) {
    if (call[0] === 'api') assert.ok(call[1].startsWith(`repos/${served}/`), call.join(' '));
    else assert.equal(call[call.findIndex(arg => arg === '-R' || arg === '--repo') + 1], served, call.join(' '));
  }
  assert.ok(ghCalls.some(call => call.join(' ').startsWith(`api repos/${served}/issues/8/events`)),
    "the owner's needs-owner brake on #8 was looked up before it started");
  const calls = gitCalls();
  const clones = calls.filter(({args}) => args.includes('clone'));
  assert.equal(clones.length, 1, 'the run was cloned through git');
  assert.equal(clones[0].dir, checkout);
  assert.equal(clones[0].args[clones[0].args.indexOf('--reference') + 1], checkout, "the configured checkout's objects");
  assert.equal(clones[0].args.at(-1), join(checkout, '.worktrees/issue-8'));
  // The script's own checkout is Triphammer's, which the tick keeps current and reads the plugin from, and the
  // configured one is another repository; every other git call is in the configured checkout.
  for (const {dir, args} of calls) assert.ok(inside(dir, checkout) || inside(dir, r.checkout), `git ${args.join(' ')} in ${dir}`);
  assert.equal(existsSync(join(checkout, '.worktrees/issue-8')), false, "the run made progress and its clone is gone");
  assert.equal(existsSync(join(r.checkout, '.worktrees')), false, "the script's own checkout is untouched");
  assert.match(readFileSync(join(state, 'log'), 'utf8'), /ticket #8: run 1 finished/);
  assert.equal(existsSync(join(r.root, 'state/ticket-runner/log')), false);
});

test('a missing config file stops the runner before any gh or git call, naming the file', t => {
  const r = ticketSetup(t);
  const gitCalls = recordGit(r);
  const missing = join(r.root, 'nowhere.conf');
  assert.throws(() => r.tick({TRIPHAMMER_CONFIG: missing}),
    error => error.status === 2 && error.stderr.includes(`ticket-runner: the Triphammer config ${missing} is missing or unreadable`));
  assert.deepEqual(r.ghCalls(), []);
  assert.deepEqual(gitCalls(), []);
  assert.equal(r.ran(), false);
});

test('a config without a required setting, or with a malformed line, stops the runner before any gh or git call', t => {
  for (const [settings, message] of [
    [{APP_AUTHOR: null}, 'does not set APP_AUTHOR'],
    [{REPO: ''}, 'does not set REPO'],
    [{CHECKOUT: 'relative/path'}, 'CHECKOUT must be an absolute path, not relative/path'],
    [{OWNER: 'two people'}, 'OWNER must be one GitHub login (letters, digits and single dashes between them, at most 39 characters), not two people'],
    [{OWNER: '-dash-first'}, 'OWNER must be one GitHub login'],
    [{OWNER: 'double--dash'}, 'OWNER must be one GitHub login'],
    [{OWNER: 'Example-Org/example-project'}, 'OWNER must be one GitHub login'],
    [{OWNER: 'a'.repeat(40)}, 'OWNER must be one GitHub login'],
  ]) {
    const r = ticketSetup(t);
    writeConfig(r.configFile, {REPO: repo, CHECKOUT: r.checkout, APP_AUTHOR: 'app/x', STATE_DIR: join(r.root, 'state'), ...settings});
    const gitCalls = recordGit(r);
    assert.throws(() => r.tick(), error => error.status === 2 && error.stderr.includes(`${r.configFile}`) && error.stderr.includes(message),
      message);
    assert.deepEqual(r.ghCalls(), [], message);
    assert.deepEqual(gitCalls(), [], message);
  }
  const r = ticketSetup(t);
  writeFileSync(r.configFile, `REPO=${repo}\nCHECKOUT ${r.checkout}\n`);
  assert.throws(() => r.tick(), error => error.status === 2 && error.stderr.includes(`${r.configFile} line 2 is not KEY=value`));
  assert.deepEqual(r.ghCalls(), []);
});

test('a config with OWNER, a GitHub login, is accepted, and one without it still is', t => {
  for (const value of ['example-person', 'Example-Person-2', 'a'.repeat(39), null]) {
    const r = ticketSetup(t, [{...issue(7), author: {is_bot: false, login: value ?? 'Example-Owner'}}], {config: {OWNER: value}});
    assert.equal(r.tick({}, ['--plan']).trim(), 'ticket 7', String(value));
  }
});

test('without TRIPHAMMER_CONFIG the config is <name>.conf under XDG_CONFIG_HOME, <name> from the project file', t => {
  const r = ticketSetup(t, [issue(7)], {project: project({name: 'widgets'})});
  const dir = join(r.root, 'xdg/triphammer');
  mkdirSync(dir, {recursive: true});
  writeConfig(join(dir, 'widgets.conf'), {REPO: repo, CHECKOUT: r.checkout, APP_AUTHOR: author.login, STATE_DIR: join(r.root, 'state/ticket-runner')});
  assert.equal(r.tick({TRIPHAMMER_CONFIG: '', XDG_CONFIG_HOME: join(r.root, 'xdg')}, ['--plan']).trim(), 'ticket 7');
  assert.throws(() => r.tick({TRIPHAMMER_CONFIG: '', XDG_CONFIG_HOME: join(r.root, 'other')}, ['--plan']),
    error => error.stderr.includes(`the Triphammer config ${join(r.root, 'other/triphammer/widgets.conf')} is missing`));
});

test('a malformed project file stops the tick, naming the file and the field', t => {
  const r = ticketSetup(t, [issue(7)], {project: project({composeProjectPattern: '^(unclosed'})});
  assert.throws(() => r.tick(), error => error.status === 2
    && error.stderr.includes(`${join(r.checkout, '.triphammer/project.json')} is malformed: composeProjectPattern is not a valid`));
  assert.equal(r.ran(), false);
});

test('a project file whose demos is not true or false stops the tick', t => {
  const r = ticketSetup(t, [issue(7)], {project: project({demos: 'yes'})});
  assert.throws(() => r.tick(), error => error.status === 2
    && error.stderr.includes(`${join(r.checkout, '.triphammer/project.json')} is malformed: demos must be true or false`));
  assert.equal(r.ran(), false);
});

test('a project file whose check command is not plain words, or names an unknown check, stops the tick', t => {
  for (const [checks, message] of [
    [{suite: 'make check && curl x'}, 'checks.suite must be a command'],
    [{lint: 'make lint'}, 'checks may name only build, focused, suite and gate, not lint'],
    [{focused: '<x>'}, 'checks.focused must start with a command word, not a <placeholder>'],
  ]) {
    const r = ticketSetup(t, [issue(7)], {project: project({checks})});
    assert.throws(() => r.tick(), error => error.status === 2
      && error.stderr.includes(`${join(r.checkout, '.triphammer/project.json')} is malformed: ${message}`), message);
    assert.equal(r.ran(), false);
  }
});

test('a project file whose shellEditRoots is not a list of relative paths inside the repository stops the tick', t => {
  for (const shellEditRoots of ['src', ['src', 3], ['/src'], ['../src'], ['src/../..'], ['.'], ['src//App'], ['']]) {
    const r = ticketSetup(t, [issue(7)], {project: project({shellEditRoots})});
    assert.throws(() => r.tick(), error => error.status === 2
      && error.stderr.includes(`${join(r.checkout, '.triphammer/project.json')} is malformed: shellEditRoots must be a list `
        + 'of paths relative to the repository root, inside it'), JSON.stringify(shellEditRoots));
    assert.equal(r.ran(), false);
  }
  for (const shellEditRoots of [[], ['src', 'tests'], ['src/App/', 'lib']]) {
    const r = ticketSetup(t, [issue(7)], {project: project({shellEditRoots})});
    r.tick();
    assert.equal(r.ran(), true, JSON.stringify(shellEditRoots));
  }
});

test("a project's teardown command runs in the run's clone, with its arguments, before the clone is removed", t => {
  const r = ticketSetup(t, [issue(7)], {project: project({worktreeTeardown: ['tools/stop.sh', 'now']}), files: {
    'tools/stop.sh': `#!/bin/sh\necho "$PWD $*" > "$PROBE/teardown"\necho first\necho stopped everything\n`,
  }});
  r.gh.respond({'issue view 7': {stdout: 'yes\n'}});
  r.tick();
  assert.equal(r.probe('teardown'), `${r.worktree} now\n`);
  assert.match(r.log(), new RegExp(`tore down ${r.worktree}: stopped everything\n`));
  assert.equal(existsSync(r.worktree), false);
});

test("a project's teardown command runs under the write limit, with the run's clone as the one checkout it may write and the project's caches", t => {
  const r = ticketSetup(t, [issue(7)], {project: project({worktreeTeardown: ['tools/stop.sh', 'now']}), files: {
    'tools/stop.sh': '#!/bin/sh\nexit 0\n',
  }});
  r.gh.respond({'issue view 7': {stdout: 'yes\n'}});
  r.tick();
  const calls = r.bwrapCalls();
  const teardown = calls.filter(call => call[call.indexOf('--') + 1] === join(r.worktree, 'tools/stop.sh'));
  assert.equal(teardown.length, 1, JSON.stringify(calls));
  const [call] = teardown;
  assert.deepEqual(call.slice(call.indexOf('--')), ['--', join(r.worktree, 'tools/stop.sh'), 'now']);
  assertWriteLimit(r, call, r.worktree);
  assertProjectCaches(r, call);
});

test('a run directory the write limit refuses, a git worktree, runs no teardown and is still removed', t => {
  const r = sweepSetup(t);
  r.tick();
  const pr20 = r.worktree('pr-20');
  assert.ok(!r.bwrapCalls().some(call => call[call.indexOf('--') + 1]?.startsWith(`${pr20}/`)), 'no teardown ran in it');
  assert.match(r.log(), new RegExp(`teardown failed in ${pr20}: session-sandbox: the git directory .* lies outside it`));
  assert.ok(r.log().includes(`removed run directory ${pr20} (pull request #20 is merged)\n`));
});

test('a project with no teardown command gets its clone removed with no teardown run and nothing logged about it', t => {
  const r = ticketSetup(t, [issue(7)], {project: without('worktreeTeardown')});
  const db = localDb(r.worktree);
  writeFileSync(join(r.root, 'session-db.json'), JSON.stringify([[db, join(r.worktree, 'database')]]));  // local-db.sh up
  r.gh.respond({'issue view 7': {stdout: 'yes\n'}});
  r.tick();
  assert.equal(existsSync(r.worktree), false);
  assert.deepEqual(r.docker.calls().filter(call => call.includes('compose --file')), [], 'scripts/local-db.sh down never ran');
  assert.doesNotMatch(r.log(), /tore down|teardown/);
});

test('a project with no compose pattern gets no database sweep: no docker call and no log line', t => {
  const r = ticketSetup(t, [recentUpkeep], {project: without('composeProjectPattern')});
  r.docker.containers([['example-project-local-1', join(r.root, 'gone/database')]]);
  r.tick();
  assert.deepEqual(r.docker.calls(), []);
  assert.doesNotMatch(existsSync(join(r.root, 'state/ticket-runner/log')) ? r.log() : '', /database/);
});

test("a compose pattern that does not match the example project's names prunes only the projects it matches", t => {
  const r = ticketSetup(t, [recentUpkeep], {project: project({composeProjectPattern: '^widgets-db-[0-9]+$'})});
  r.docker.containers([
    ['example-project-local-1', join(r.root, 'gone/database')],
    ['example-project-it-2', join(r.root, 'gone/database')],
    ['widgets-db-3', join(r.root, 'issue-9/database')],
  ]);
  r.tick();
  assert.deepEqual(r.docker.calls().filter(call => call.includes(' down ')), ['|compose -p widgets-db-3 down --volumes --remove-orphans']);
  assert.ok(r.log().includes(`pruned database widgets-db-3 (run directory ${join(r.root, 'issue-9')} is gone)\n`));
  assert.doesNotMatch(r.log(), /example-project-/);
});

// Two projects on one machine, as ticket-runner@a and ticket-runner@b run them: each a ticketSetup (its own repository fakes,
// checkout and state directory) whose config is a.conf or b.conf under one XDG_CONFIG_HOME, both with one
// XDG_STATE_HOME, so they share the shared directory `sharedDir`. Each project's `tick` runs it, `runs` counts the runs its
// log started, and `tickCommand` writes a program that runs one tick of it with the extra environment given, for
// another project's session to run.
function twoProjects(t, {a = [issue(7)], b = [issue(7)]} = {}) {
  return projects(t, {a, b});
}
// The same for any number of projects, one per key of `issuesByName`.
function projects(t, issuesByName) {
  const shared = mkdtempSync(join(tmpdir(), 'triphammer-projects-'));
  t.after(() => rmSync(shared, {recursive: true, force: true}));
  mkdirSync(join(shared, 'xdg/triphammer'), {recursive: true});
  let commands = 0;
  const project = (name, issues) => {
    const r = ticketSetup(t, issues);
    writeFileSync(join(shared, `xdg/triphammer/${name}.conf`), readFileSync(r.configFile, 'utf8'));
    const env = {TRIPHAMMER_CONFIG: '', TRIPHAMMER_PROJECT: name, XDG_CONFIG_HOME: join(shared, 'xdg'),
      XDG_STATE_HOME: join(shared, 'state')};
    const logFile = join(r.root, 'state/ticket-runner/log');
    const log = () => existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    const quote = value => `'${String(value).replaceAll("'", `'\\''`)}'`;
    return {
      ...r,
      tick: (more = {}) => r.tick({...env, ...more}),
      log,
      runs: () => (log().match(/: run \d of 3 starting/g) ?? []).length,
      tickCommand(more = {}) {
        const all = {...r.env, DEMO_CALLS: join(r.root, 'demo-calls'), PROBE: r.root, ...env, ...more};
        const file = join(shared, `tick-${name}-${++commands}`);
        writeFileSync(file, `#!/bin/sh\nexec env -i ${Object.entries(all).map(([k, v]) => `${k}=${quote(v)}`).join(' ')} ${
          quote(join(r.checkout, 'bin/ticket-runner'))}\n`, {mode: 0o755});
        return file;
      },
    };
  };
  const sharedDir = join(shared, 'state/triphammer');
  return {...Object.fromEntries(Object.entries(issuesByName).map(([name, issues]) => [name, project(name, issues)])),
    sharedDir, root: shared,
    maxSessions(text) {
      mkdirSync(sharedDir, {recursive: true});
      writeFileSync(join(sharedDir, 'max-sessions'), text);
    }};
}

test("a session in one project holds the other project's tick, which starts nothing and waits for its turn", t => {
  const {a, b, sharedDir} = twoProjects(t);
  a.tick({DURING_SESSION: b.tickCommand()});
  assert.equal(a.runs(), 1);
  assert.equal(b.ran(), false, 'no session started in b while a ran');
  assert.equal(b.runs(), 0);
  assert.ok(existsSync(join(sharedDir, 'waiting/b')), 'b marked itself waiting');
  assert.equal(readFileSync(join(sharedDir, 'last'), 'utf8'), 'a\n');
});

test('after a run in one project with work waiting in both, the next run is in the other', t => {
  const {a, b, sharedDir} = twoProjects(t);
  a.tick({DURING_SESSION: b.tickCommand()});  // b's tick during a's run marks b waiting
  a.tick();
  assert.equal(a.runs(), 1, 'a ran last and b is waiting, so a yields');
  assert.match(a.log(), /ticket #7: a ran last and b is waiting; yielding this turn to it/);
  b.tick();
  assert.equal(b.runs(), 1);
  assert.equal(existsSync(join(sharedDir, 'waiting/b')), false, 'b starting a run clears its mark');
  a.tick();
  assert.equal(a.runs(), 2, 'b ran last, so a takes the next turn');
});

test('a waiting mark older than three ticks does not make the project that ran last yield', t => {
  const {a, sharedDir} = twoProjects(t);
  a.tick();
  writeFileSync(join(sharedDir, 'waiting/b'), `${Math.floor(Date.now() / 1000) - 3600}\n`);
  a.tick();
  assert.equal(a.runs(), 2);
});

test('a project with nothing to do clears its waiting mark', t => {
  const {b, sharedDir} = twoProjects(t, {b: [recentUpkeep, held(7)]});
  mkdirSync(join(sharedDir, 'waiting'), {recursive: true});
  writeFileSync(join(sharedDir, 'waiting/b'), `${Math.floor(Date.now() / 1000)}\n`);
  b.tick();
  assert.equal(b.ran(), false);
  assert.equal(existsSync(join(sharedDir, 'waiting/b')), false);
});

test('a usage limit in one project pauses every project', t => {
  const {a, b, sharedDir} = twoProjects(t);
  a.tick({CLAUDE_EXIT: '1', CLAUDE_SAYS: 'Claude usage limit reached'});
  assert.match(a.log(), /stopped by a usage or rate limit/);
  assert.ok(Number(readFileSync(join(sharedDir, 'backoff'), 'utf8')) > Date.now() / 1000);
  b.tick();
  assert.equal(b.ran(), false);
  a.tick();
  assert.equal(a.runs(), 1);
});

test("one project's stop file pauses only that project, and the shared stop file pauses every project", t => {
  const one = twoProjects(t);
  mkdirSync(join(one.a.root, 'state/ticket-runner'), {recursive: true});
  writeFileSync(join(one.a.root, 'state/ticket-runner/stop'), '');
  one.a.tick();
  one.b.tick();
  assert.equal(one.a.ran(), false);
  assert.equal(one.b.ran(), true);
  const all = twoProjects(t);
  mkdirSync(all.sharedDir, {recursive: true});
  writeFileSync(join(all.sharedDir, 'stop'), '');
  all.a.tick();
  all.b.tick();
  assert.equal(all.a.ran(), false);
  assert.equal(all.b.ran(), false);
});

test('a TRIPHAMMER_PROJECT that is not a project name stops the runner before any gh call', t => {
  const r = ticketSetup(t);
  assert.throws(() => r.tick({TRIPHAMMER_CONFIG: '', TRIPHAMMER_PROJECT: '../a'}),
    error => error.status === 2 && /TRIPHAMMER_PROJECT must be a project name/.test(error.stderr));
  assert.deepEqual(r.ghCalls(), []);
});

// The owner's brakes during a session. The session (the fake `claude` through $DURING_SESSION) starts a child that
// ignores SIGTERM, records its pid, applies the brake $BRAKE names (touches the file $BRAKE_FILE, or adds the gh
// routes in $BRAKE_ROUTES, then those in $BRAKE_ROUTES_THEN once gh has been called with a route of $BRAKE_ROUTES) and
// then waits $SESSION_SECONDS (default 30) for that child; the runner checks the brakes every tenth of a second and
// allows one second between SIGTERM and SIGKILL. A brake check reads the issue's labels and then its events, so a test
// that changes both adds the labels first and the events then: a check never reads the old labels with the new events.
const brakeEnv = {TICKET_RUNNER_BRAKE_SECONDS: '0.1', TICKET_RUNNER_BRAKE_GRACE_SECONDS: '1'};
function brakeSession(r) {
  const script = join(r.root, 'during-session');
  writeFileSync(script, `#!/bin/sh
sh -c 'trap "" TERM; sleep "\${SESSION_SECONDS:-30}"' & echo $! > "$PROBE/session-child"
[ -z "$BRAKE_FILE" ] || { mkdir -p "\${BRAKE_FILE%/*}"; touch "$BRAKE_FILE"; }
add_routes() {
  jq --argjson more "$1" '. + $more' "$PROBE/gh/routes.json" > "$PROBE/gh/routes.tmp"
  mv "$PROBE/gh/routes.tmp" "$PROBE/gh/routes.json"
}
[ -z "$BRAKE_ROUTES" ] || add_routes "$BRAKE_ROUTES"
if [ -n "$BRAKE_ROUTES_THEN" ]; then
  seen="$(wc -l < "$PROBE/gh/calls")" tries=0
  until tail -n "+$((seen + 1))" "$PROBE/gh/calls" | jq -se --argjson routes "$BRAKE_ROUTES" \\
      'any(.[] | join(" "); . as $call | $routes | keys | any(. as $key | $call | startswith($key)))' >/dev/null 2>&1 \\
      || [ "$((tries += 1))" -gt 200 ]; do sleep 0.05; done
  add_routes "$BRAKE_ROUTES_THEN"
fi
wait
`, {mode: 0o755});
  return (env = {}) => {  // $BRAKE_ROUTES and $BRAKE_ROUTES_THEN as objects, written as JSON
    const started = Date.now();
    const json = Object.entries(env).map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : value]);
    r.tick({...brakeEnv, DURING_SESSION: script, ...Object.fromEntries(json)});
    return Date.now() - started;
  };
}
const alive = pid => existsSync(`/proc/${pid}`) && !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'));
const issueView = number => `issue view ${number} -R ${repo} --json labels,state`;
// The issue events API (who added a label) and the GraphQL query for the issue's last ClosedEvent (what closed it), in
// the shapes GitHub returns; the App acts as example-agents[bot].
const eventsCall = number => `api repos/${repo}/issues/${number}/events`;
const labelledBy = (login, name = 'needs-owner') => [{event: 'labeled', label: {name: 'agent-working'}, actor: {login: 'example-agents[bot]', type: 'Bot'}},
  {event: 'labeled', label: {name}, actor: {login, type: login.endsWith('[bot]') ? 'Bot' : 'User'}}];
const closerCall = number => `api graphql -F number=${number} -f owner=Example-Owner -f name=example-project -f query=`;
const closedBy = closer => ({data: {repository: {issue: {timelineItems: {nodes: closer === undefined ? [] : [{closer}]}}}}});

function assertBrakeEnded(r, brake, {kind = 'ticket', number = 7, labelled = `issue edit ${number}`} = {}) {
  const log = r.log();
  assert.match(log, new RegExp(`${kind} #${number}: ended by the owner's brake: ${brake}; not counted`));
  assert.doesNotMatch(log, /run 1 finished|ended without progress/);
  assert.equal(readFileSync(join(r.root, `state/ticket-runner/attempts/${kind}-${number}`), 'utf8').trim(), '0',
    'the run is not counted');
  assert.equal(alive(Number(r.probe('session-child'))), false, 'the session child that ignored SIGTERM was killed');
  assert.deepEqual(labelCalls(r.ghCalls()).slice(-1), [`${labelled} -R ${repo} --remove-label agent-working`]);
  assert.equal(existsSync(r.current), false);
  assert.equal(existsSync(join(r.root, 'state/ticket-runner/brake')), false);
  assert.equal(existsSync(tokenPaths(r).dir), false, "the session's token is removed");
  assert.deepEqual(r.securityCalls(), [], 'a stopped run reviews nothing');
  assert.deepEqual(r.demoCalls(), [], 'and publishes nothing');
}

test("a run the owner's brake ended files none of its proposals and removes their directory", t => {
  const r = ticketSetup(t);
  writeFileSync(join(r.root, 'proposals.jsonl'), `${JSON.stringify(proposal('a'))}\n`);
  brakeSession(r)({BRAKE_FILE: join(r.root, 'state/ticket-runner/stop')});
  assertBrakeEnded(r, 'the stop file \\S+/state/ticket-runner/stop');
  assert.deepEqual(r.creates(), []);
  assert.equal(existsSync(join(r.probe('proposals-path'), '..')), false);
});

test("each of the owner's brakes ends a ticket session in progress, uncounted, and kills its processes", t => {
  const cases = [
    [{BRAKE_FILE: 'state/ticket-runner/stop'}, 'the stop file \\S+/state/ticket-runner/stop'],
    [{BRAKE_FILE: 'state/triphammer/stop'}, "the shared stop file \\S+/state/triphammer/stop"],
    [{BRAKE_ROUTES: {[`issue list -R ${repo} --state open --label stop-agents`]: {stdout: '99\n'}}},
      'an open issue is labelled stop-agents'],
    [{BRAKE_ROUTES: {[issueView(7)]: {file: 'brake-hold.json'}}}, 'issue #7 is labelled hold'],
    [{BRAKE_ROUTES: {[issueView(7)]: {file: 'brake-needs-owner.json'}},
      BRAKE_ROUTES_THEN: {[eventsCall(7)]: {file: 'by-owner.json'}}}, 'issue #7 is labelled needs-owner'],
    [{BRAKE_ROUTES: {[issueView(7)]: {file: 'brake-closed.json'}, [closerCall(7)]: {file: 'closed-by-hand.json'}}},
      'issue #7 is closed'],
  ];
  for (const [brake, reason] of cases) {
    const r = ticketSetup(t);
    r.gh.json('brake-hold.json', issue(7, {labels: ['agent-working', 'hold']}));
    r.gh.json('brake-needs-owner.json', issue(7, {labels: ['needs-owner']}));
    r.gh.json('by-owner.json', labelledBy('Example-Owner'));
    r.gh.json('brake-closed.json', issue(7, {state: 'CLOSED'}));
    r.gh.json('closed-by-hand.json', closedBy(null));
    const took = brakeSession(r)({...brake, BRAKE_FILE: brake.BRAKE_FILE && join(r.root, brake.BRAKE_FILE)});
    assert.ok(took < 20000, `${reason}: the run ended in ${took} ms, not after the session's 30 s`);
    assertBrakeEnded(r, reason);
  }
});

test("the owner's Hold and Needs-Owner, in another case, end a ticket session in progress", t => {
  for (const [file, labels, reason] of [['brake-hold.json', ['Hold'], 'issue #7 is labelled hold'],
    ['brake-needs-owner.json', ['Needs-Owner'], 'issue #7 is labelled needs-owner']]) {
    const r = ticketSetup(t);
    r.gh.json(file, issue(7, {labels: ['agent-working', ...labels]}));
    r.gh.json('by-owner.json', labelledBy('Example-Owner', 'Needs-Owner'));
    brakeSession(r)({BRAKE_ROUTES: {[issueView(7)]: {file}},
      BRAKE_ROUTES_THEN: {[eventsCall(7)]: {file: 'by-owner.json'}}});
    assertBrakeEnded(r, reason);
  }
});

test('Hold, in another case, on the pull request a repair works on ends the repair session in progress', t => {
  const r = repairSetup(t);
  r.gh.json('brake-pr.json', {labels: [{name: 'Hold'}]});
  brakeSession(r)({BRAKE_ROUTES: {[`pr view 40 -R ${repo} --json labels`]: {file: 'brake-pr.json'}}});
  assertBrakeEnded(r, 'pull request #40 is labelled hold', {kind: 'repair', number: 40, labelled: 'pr edit 40'});
});

// gh's --json labels reads only the first 100 labels, so one hundred labels may hide hold or needs-owner.
test('a ticket whose issue has 100 labels or more, which may hide a brake, ends the session in progress', t => {
  const r = ticketSetup(t);
  r.gh.json('brake-unread.json', issue(7, {labels: manyLabels(100)}));
  brakeSession(r)({BRAKE_ROUTES: {[issueView(7)]: {file: 'brake-unread.json'}}});
  assertBrakeEnded(r, 'issue #7 is labelled more than the runner reads, so it may be labelled hold or needs-owner');
});

test('a repair whose pull request has 100 labels or more, which may hide hold, ends the session in progress', t => {
  const r = repairSetup(t);
  r.gh.json('brake-pr.json', {labels: manyLabels(100).map(name => ({name}))});
  brakeSession(r)({BRAKE_ROUTES: {[`pr view 40 -R ${repo} --json labels`]: {file: 'brake-pr.json'}}});
  assertBrakeEnded(r, 'pull request #40 is labelled more than the runner reads, so it may be labelled hold',
    {kind: 'repair', number: 40, labelled: 'pr edit 40'});
});

// The runner adds agent-working before its first brake check, so an issue with 99 other labels would reach 100 there,
// be braked uncounted and be picked again on every tick. It is not picked.
test('an issue with 99 labels besides agent-working is not picked, so no session starts and is braked', t => {
  const r = ticketSetup(t, [recentUpkeep, issue(7, {labels: manyLabels(99)})]);
  r.gh.json('brake-unread.json', issue(7, {labels: [...manyLabels(99), 'agent-working']}));
  brakeSession(r)({BRAKE_ROUTES: {[issueView(7)]: {file: 'brake-unread.json'}}});
  assert.equal(r.ran(), false);
  assert.equal(existsSync(join(r.root, 'state/ticket-runner/attempts/ticket-7')), false, 'no run of #7 started');
  assert.equal(labelCalls(r.ghCalls()).length, 0, 'agent-working is never added');
});

test('a session that labels its own issue Needs-Owner, in another case, ends as a run that progressed', t => {
  const r = ticketSetup(t, [issue(7)]);
  r.gh.json('self-needs-owner.json', issue(7, {labels: ['agent-working', 'Needs-Owner']}));
  r.gh.json('by-app.json', labelledBy('example-agents[bot]', 'Needs-Owner'));
  const routes = {[issueView(7)]: {file: 'self-needs-owner.json'}, [eventsCall(7)]: {file: 'by-app.json'},
    [`issue view 7 -R ${repo} --json state,labels`]: {file: 'self-needs-owner.json'}};
  brakeSession(r)({BRAKE_ROUTES: routes, SESSION_SECONDS: '1'});
  const log = r.log();
  assert.ok(r.ghCalls().some(call => call.join(' ').startsWith(eventsCall(7))), 'who added Needs-Owner was looked up');
  assert.doesNotMatch(log, /owner's brake|could not look up/);
  assert.match(log, /ticket #7: run 1 finished \(exit 0\)/);
  assert.equal(existsSync(join(r.root, 'state/ticket-runner/attempts/ticket-7')), false, 'Needs-Owner is progress');
});

test('hold on the pull request a repair works on ends the repair session in progress', t => {
  const r = repairSetup(t);
  r.gh.json('brake-pr.json', {labels: [{name: 'hold'}]});
  brakeSession(r)({BRAKE_ROUTES: {[`pr view 40 -R ${repo} --json labels`]: {file: 'brake-pr.json'}}});
  assertBrakeEnded(r, 'pull request #40 is labelled hold', {kind: 'repair', number: 40, labelled: 'pr edit 40'});
});

test('an upkeep session that closes its own issue is not stopped by the closed issue', t => {
  const r = ticketSetup(t, []);
  r.gh.json('upkeep-closed.json', issue(90, {state: 'CLOSED', labels: ['upkeep']}));
  r.gh.respond({[issueView(90)]: {file: 'upkeep-closed.json'}, 'issue view 90 -R': {stdout: 'yes\n'}});  // and progressed
  brakeSession(r)({SESSION_SECONDS: '1'});
  assert.ok(r.ghCalls().some(call => call.join(' ').startsWith(issueView(90))), 'the brakes were checked');
  assert.doesNotMatch(r.log(), /owner's brake/);
  assert.match(r.log(), /ticket #90: run 1 finished \(exit 0\)/);
});

test("the run's own pull request merging and closing the issue does not end the session, which publishes its demo", t => {
  const r = ticketSetup(t);
  r.gh.json('merged-closed.json', issue(7, {state: 'CLOSED'}));
  r.gh.json('closed-by-merge.json', closedBy({merged: true}));
  // merge-when-ready merges the session's pull request while its demo agent still runs, and GitHub closes #7.
  const routes = {[issueView(7)]: {file: 'merged-closed.json'}, [closerCall(7)]: {file: 'closed-by-merge.json'},
    [`issue view 7 -R ${repo} --json state,labels`]: {file: 'merged-closed.json'}};
  brakeSession(r)({BRAKE_ROUTES: routes, SESSION_SECONDS: '1'});
  const log = r.log();
  assert.ok(r.ghCalls().some(call => call.join(' ').startsWith(closerCall(7))), 'the closer was looked up');
  assert.doesNotMatch(log, /owner's brake|could not look up/);
  assert.match(log, /ticket #7: demo risk-journey: published PR #77/);
  assert.match(log, /ticket #7: run 1 finished \(exit 0\)/);
  assert.equal(r.demoCalls().length, 1);
});

// GitHub compares logins in any case, so the App's login in another case than APP_AUTHOR's is still the App, and so is
// the App of an APP_AUTHOR that writes gh's app/ prefix in another case.
for (const [appAuthor, appLogin] of [['app/example-agents', 'example-agents[bot]'],
  ['app/example-agents', 'Example-Agents[bot]'], ['App/Example-Agents', 'example-agents[bot]']]) test(`a session that labels its own issue needs-owner (as ${appLogin}, APP_AUTHOR ${appAuthor}) goes on to comment and ends as a run that progressed`, t => {
  const r = ticketSetup(t, [issue(7)], {config: {APP_AUTHOR: appAuthor}});
  r.gh.json('self-needs-owner.json', issue(7, {labels: ['agent-working', 'needs-owner']}));
  r.gh.json('by-app.json', labelledBy(appLogin));
  const routes = {[issueView(7)]: {file: 'self-needs-owner.json'}, [eventsCall(7)]: {file: 'by-app.json'},
    [`issue view 7 -R ${repo} --json state,labels`]: {file: 'self-needs-owner.json'}};
  brakeSession(r)({BRAKE_ROUTES: routes, SESSION_SECONDS: '1'});  // then writes its comment
  const log = r.log();
  assert.ok(r.ghCalls().some(call => call.join(' ').startsWith(eventsCall(7))), 'who added needs-owner was looked up');
  assert.doesNotMatch(log, /owner's brake|could not look up/);
  assert.match(log, /ticket #7: run 1 finished \(exit 0\)/);
  assert.equal(existsSync(join(r.root, 'state/ticket-runner/attempts/ticket-7')), false, 'needs-owner is progress');
  assert.equal(existsSync(r.worktree), false);
});

test('a brake ends the Bash tool commands that run in sessions of their own, and what they started', t => {
  const r = ticketSetup(t);
  const script = join(r.root, 'tool-command');
  // As Claude Code runs a Bash tool command: in a session of its own, whose child ignores SIGTERM.
  writeFileSync(script, `#!/bin/sh
setsid sh -c 'echo $$ > "$PROBE/tool-pid"; sh -c "trap \\"\\" TERM; sleep 30" & echo $! > "$PROBE/session-child"; wait' &
while [ ! -s "$PROBE/session-child" ]; do sleep 0.05; done
touch "$XDG_STATE_HOME/ticket-runner/stop"
sleep 30
`, {mode: 0o755});
  r.tick({...brakeEnv, DURING_SESSION: script});
  assert.equal(alive(Number(r.probe('tool-pid'))), false, 'the tool command was ended');
  assertBrakeEnded(r, 'the stop file \\S+/state/ticket-runner/stop');
});

test('a needs-owner actor or a closer that cannot be looked up is logged and does not end the session', t => {
  const r = ticketSetup(t);
  r.gh.json('both.json', issue(7, {state: 'CLOSED', labels: ['needs-owner']}));
  r.gh.json('no-events.json', []);
  r.gh.respond({[issueView(7)]: {file: 'both.json'}, [eventsCall(7)]: {file: 'no-events.json'},
    [closerCall(7)]: {stderr: 'gh: HTTP 502\n', exit: 1}});
  brakeSession(r)({SESSION_SECONDS: '1'});
  const log = r.log();
  assert.match(log, /ticket #7: could not look up who labelled issue #7 needs-owner/);
  assert.match(log, /ticket #7: could not look up what closed issue #7/);
  assert.doesNotMatch(log, /owner's brake/);
});

// The owner's needs-owner brake outlives its label: it is on from the owner's last `labeled` event for it until a later
// `unlabeled` one by anyone but the App, whatever the App does in between.
const labelEvent = (event, login, name = 'needs-owner') => ({event, label: {name}, actor: {login}});
const ownerThenApp = [labelEvent('labeled', 'Example-Owner'), labelEvent('unlabeled', 'example-agents[bot]')];
const ownerAppApp = [...ownerThenApp, labelEvent('labeled', 'Example-Agents[bot]', 'Needs-Owner')];
const ownerThenOwner = [labelEvent('labeled', 'example-owner'), labelEvent('unlabeled', 'Example-Owner', 'Needs-Owner')];
// Serves events as issue #number's events to the rig's gh.
const serveEvents = (r, number, events) => {
  r.gh.json('events.json', events);
  r.gh.respond({[eventsCall(number)]: {file: 'events.json'}});
};

test("an issue whose needs-owner the owner added and the App removed is not started; the owner's removal lifts it", t => {
  const braked = ticketSetup(t, [issue(7), issue(8)]);
  serveEvents(braked, 7, ownerThenApp);
  assert.equal(braked.tick({}, ['--plan']).trim(), 'ticket 8');

  const alone = ticketSetup(t, [upkeepIssue(1, 1, 'CLOSED'), issue(7)]);
  serveEvents(alone, 7, ownerThenApp);
  alone.tick();
  assert.equal(alone.ran(), false);
  assert.match(alone.log(), /#7: skipped: the owner added needs-owner, and only the owner's removal lifts it/);

  const lifted = ticketSetup(t, [issue(7), issue(8)]);
  serveEvents(lifted, 7, ownerThenOwner);
  assert.equal(lifted.tick({}, ['--plan']).trim(), 'ticket 7');
});

test("a parent whose needs-owner the owner added and the App removed stays open when its last slice closes", t => {
  const parent = {...issue(10), body: ''};
  const r = ticketSetup(t, [parent, {...issue(11, {state: 'CLOSED'}), body: 'Slice 1 of #10.'}, issue(20)]);
  serveEvents(r, 10, ownerThenApp);
  assert.equal(r.tick({}, ['--plan']).trim(), 'ticket 20');
});

test('an issue whose needs-owner events cannot be looked up is not started', t => {
  const r = ticketSetup(t, [upkeepIssue(1, 1, 'CLOSED'), issue(7)]);
  r.gh.respond({[eventsCall(7)]: {stderr: 'gh: HTTP 502\n', exit: 1}});
  assert.equal(r.tick({}, ['--plan']).trim(), 'idle');
  r.tick();
  assert.equal(r.ran(), false);
  assert.match(r.log(), /#7: could not read the events of issue #7, so the owner's brakes on it are unknown; skipping it this tick/);
});

test("the owner's needs-owner ends a session in progress after the App removed it, or after the App added it again", t => {
  for (const [labels, events, reason] of [[[], ownerThenApp, "issue #7 is under the owner's needs-owner, which the App removed"],
    [['Needs-Owner'], ownerAppApp, 'issue #7 is labelled needs-owner']]) {
    const r = ticketSetup(t);
    r.gh.json('braked.json', issue(7, {labels: ['agent-working', ...labels]}));
    r.gh.json('events.json', events);
    brakeSession(r)({BRAKE_ROUTES: {[issueView(7)]: {file: 'braked.json'}},
      BRAKE_ROUTES_THEN: {[eventsCall(7)]: {file: 'events.json'}}});
    assertBrakeEnded(r, reason);
  }
});

test("needs-owner the owner added and removed again does not end the session", t => {
  const r = ticketSetup(t);
  r.gh.json('events.json', ownerThenOwner);
  r.gh.respond({'issue view 7 -R': {stdout: 'yes\n'}});  // and progressed
  brakeSession(r)({BRAKE_ROUTES: {[eventsCall(7)]: {file: 'events.json'}}, SESSION_SECONDS: '1'});
  assert.ok(r.ghCalls().some(call => call.join(' ').startsWith(eventsCall(7))), 'the events were looked up');
  assert.doesNotMatch(r.log(), /owner's brake|could not look up/);
  assert.match(r.log(), /ticket #7: run 1 finished \(exit 0\)/);
});

test('a failed brake lookup is logged and does not end the session', t => {
  const r = ticketSetup(t);
  r.gh.respond({[issueView(7)]: {stderr: 'gh: HTTP 502\n', exit: 1}});
  brakeSession(r)({SESSION_SECONDS: '1'});
  const log = r.log();
  assert.match(log, /ticket #7: could not look up the brakes on issue #7/);
  assert.doesNotMatch(log, /owner's brake/);
  assert.match(log, /ticket #7: run 1 ended without progress \(exit 0\)/);
  assert.equal(readFileSync(join(r.root, 'state/ticket-runner/attempts/ticket-7'), 'utf8').trim(), '1');
});

// The owner's hold and close outlive the label and the issue's state the same way, and stop-agents outlives the App's
// unlabelling or closing of its issue; a failed read of the events brakes.
const stateEvent = (event, login) => ({event, actor: {login}});
const holdThenApp = [labelEvent('labeled', 'Example-Owner', 'hold'), labelEvent('unlabeled', 'example-agents[bot]', 'hold')];
const holdThenOwner = [labelEvent('labeled', 'Example-Owner', 'Hold'), labelEvent('unlabeled', 'example-owner', 'hold')];
const closedThenApp = [stateEvent('closed', 'Example-Owner'), stateEvent('reopened', 'example-agents[bot]')];
const closedThenOwner = [stateEvent('closed', 'Example-Owner'), stateEvent('reopened', 'Example-Owner')];
const failedRead = {stderr: 'gh: HTTP 502\n', exit: 1};

test("an issue whose hold the owner added and the App removed is not started; the owner's removal lifts it", t => {
  const braked = ticketSetup(t, [issue(7), issue(8)]);
  serveEvents(braked, 7, holdThenApp);
  assert.equal(braked.tick({}, ['--plan']).trim(), 'ticket 8');

  const alone = ticketSetup(t, [upkeepIssue(1, 1, 'CLOSED'), issue(7)]);
  serveEvents(alone, 7, holdThenApp);
  alone.tick();
  assert.equal(alone.ran(), false);
  assert.match(alone.log(), /#7: skipped: the owner added hold, and only the owner's removal lifts it/);

  const lifted = ticketSetup(t, [issue(7), issue(8)]);
  serveEvents(lifted, 7, holdThenOwner);
  assert.equal(lifted.tick({}, ['--plan']).trim(), 'ticket 7');
});

test("an issue the owner closed and the App reopened is neither started nor closed; the owner's reopening lifts it", t => {
  const braked = ticketSetup(t, [issue(7), issue(8)]);
  serveEvents(braked, 7, closedThenApp);
  assert.equal(braked.tick({}, ['--plan']).trim(), 'ticket 8');

  const alone = ticketSetup(t, [upkeepIssue(1, 1, 'CLOSED'), issue(7)]);
  serveEvents(alone, 7, closedThenApp);
  alone.tick();
  assert.equal(alone.ran(), false);
  assert.match(alone.log(), /#7: skipped: the owner closed it, and only the owner's reopening lifts it/);

  const parent = ticketSetup(t, [{...issue(10), body: ''}, {...issue(11, {state: 'CLOSED'}), body: 'Slice 1 of #10.'}, issue(20)]);
  serveEvents(parent, 10, closedThenApp);
  assert.equal(parent.tick({}, ['--plan']).trim(), 'ticket 20');

  const lifted = ticketSetup(t, [issue(7), issue(8)]);
  serveEvents(lifted, 7, closedThenOwner);
  assert.equal(lifted.tick({}, ['--plan']).trim(), 'ticket 7');
});

test("a pull request whose hold the owner added and the App removed is not repaired; the owner's removal lifts it", t => {
  const braked = repairSetup(t);
  serveEvents(braked, 40, holdThenApp);
  assert.equal(braked.tick({}, ['--plan']).trim(), 'upkeep');
  braked.tick();
  assert.match(braked.log(), /#40: skipped: the owner added hold, and only the owner's removal lifts it/);
  assert.doesNotMatch(braked.log(), /repair #40/);

  const unread = repairSetup(t);
  unread.gh.respond({[eventsCall(40)]: failedRead});
  assert.equal(unread.tick({}, ['--plan']).trim(), 'upkeep');
  unread.tick();
  assert.match(unread.log(), /#40: could not read the events of pull request #40, so the owner's brakes on it are unknown/);

  const lifted = repairSetup(t);
  serveEvents(lifted, 40, holdThenOwner);
  assert.equal(lifted.tick({}, ['--plan']).trim(), 'repair 40 30 conflicts');
});

test("the owner's hold or close ends a ticket session in progress after the App removed or reopened it", t => {
  for (const [events, reason] of [[holdThenApp, "issue #7 is under the owner's hold, which the App removed"],
    [closedThenApp, "issue #7 is under the owner's close, which only the owner's reopening lifts"]]) {
    const r = ticketSetup(t);
    r.gh.json('events.json', events);
    brakeSession(r)({BRAKE_ROUTES: {[eventsCall(7)]: {file: 'events.json'}}});
    assertBrakeEnded(r, reason);
  }
});

test("the owner's hold or close lifted by the owner does not end the session", t => {
  for (const events of [holdThenOwner, closedThenOwner]) {
    const r = ticketSetup(t);
    r.gh.json('events.json', events);
    brakeSession(r)({BRAKE_ROUTES: {[eventsCall(7)]: {file: 'events.json'}}, SESSION_SECONDS: '1'});
    assert.ok(r.ghCalls().some(call => call.join(' ').startsWith(eventsCall(7))), 'the events were looked up');
    assert.doesNotMatch(r.log(), /owner's brake|could not/);
  }
});

test("a failed read of the issue's events ends a ticket session in progress", t => {
  const r = ticketSetup(t);
  brakeSession(r)({BRAKE_ROUTES: {[eventsCall(7)]: failedRead}});
  assertBrakeEnded(r, "issue #7 is unchecked: its events, which hold the owner's brakes, could not be read");
  assert.match(r.log(), /ticket #7: could not read the events of issue #7/);
});

test("the owner's hold the App removed, or a failed read of the events, ends the repair session in progress", t => {
  for (const [route, reason] of [[{file: 'events.json'}, "pull request #40 is under the owner's hold, which the App removed"],
    [failedRead, "pull request #40 is unchecked: its events, which hold the owner's hold, could not be read"]]) {
    const r = repairSetup(t);
    r.gh.json('events.json', holdThenApp);
    brakeSession(r)({BRAKE_ROUTES: {[eventsCall(40)]: route}});
    assertBrakeEnded(r, reason, {kind: 'repair', number: 40, labelled: 'pr edit 40'});
  }
});

// The repository's issue events (newest first) name the issues someone labelled stop-agents; issue #9's own events then
// say whether the owner's stop-agents still holds.
const repoEventsCall = `api repos/${repo}/issues/events`;
const repoEvent = (number, event, login, name, created_at = '2026-10-17T10:00:00Z') =>
  ({created_at, event, actor: {login}, label: {name}, issue: {number}});
const stopAgentsBy = login => [repoEvent(9, 'labeled', login, 'stop-agents')];
const serveStopAgents = (r, issueEvents, repoEvents = stopAgentsBy('Example-Owner')) => {
  r.gh.json('repo-events.json', repoEvents);
  r.gh.json('stop-events.json', issueEvents);
  r.gh.respond({[repoEventsCall]: {file: 'repo-events.json'}, [eventsCall(9)]: {file: 'stop-events.json'}});
};
const stopLabel = (event, login) => labelEvent(event, login, 'stop-agents');
const stopAgentsCases = {
  'closed by the App': [stopLabel('labeled', 'Example-Owner'), stateEvent('closed', 'example-agents[bot]')],
  'unlabelled by the App': [stopLabel('labeled', 'Example-Owner'), stopLabel('unlabeled', 'example-agents[bot]')],
  'labelled after an owner close the App reopened, then closed by the App': [stateEvent('closed', 'Example-Owner'),
    stateEvent('reopened', 'example-agents[bot]'), stopLabel('labeled', 'Example-Owner'),
    stateEvent('closed', 'example-agents[bot]')],
  'closed and reopened by the owner, then unlabelled by the App': [stopLabel('labeled', 'Example-Owner'),
    stateEvent('closed', 'Example-Owner'), stateEvent('reopened', 'Example-Owner'),
    stopLabel('unlabeled', 'example-agents[bot]')],
};
const stopAgentsLifted = {
  'closed by the owner': [stopLabel('labeled', 'Example-Owner'), stateEvent('closed', 'Example-Owner')],
  'unlabelled by the owner': [stopLabel('labeled', 'Example-Owner'), stopLabel('unlabeled', 'example-owner')],
  'closed by the owner and reopened by the App': [stopLabel('labeled', 'Example-Owner'),
    stateEvent('closed', 'Example-Owner'), stateEvent('reopened', 'example-agents[bot]')],
};
const stopAgentsPaused = /paused: issue #9, under the owner's stop-agents, which only the owner's unlabelling or closing lifts/;

test("an issue the owner labelled stop-agents pauses the project after the App closed or unlabelled it; the owner's lifts it", t => {
  for (const [name, events] of Object.entries(stopAgentsCases)) {
    const r = ticketSetup(t);
    serveStopAgents(r, events);
    r.tick();
    assert.equal(r.ran(), false, name);
    assert.match(r.log(), stopAgentsPaused, name);
    assert.match(r.tick({}, ['--plan']), stopAgentsPaused, name);
  }
  for (const [name, events] of Object.entries(stopAgentsLifted)) {
    const r = ticketSetup(t);
    serveStopAgents(r, events);
    assert.equal(r.tick({}, ['--plan']).trim(), 'ticket 7', name);
  }
  const byApp = ticketSetup(t);
  serveStopAgents(byApp, stopAgentsCases['closed by the App'], stopAgentsBy('example-agents[bot]'));
  assert.equal(byApp.tick({}, ['--plan']).trim(), 'ticket 7', "the App's own label pauses only while the issue is open with it");
});

test('an issue the owner labelled stop-agents keeps pausing after its label event is past the events the runner reads again', t => {
  const r = ticketSetup(t);
  serveStopAgents(r, stopAgentsCases['unlabelled by the App']);
  assert.match(r.tick({}, ['--plan']), stopAgentsPaused);
  r.gh.json('repo-events.json', [repoEvent(3, 'labeled', 'Example-Owner', 'bug', '2026-10-17T11:00:00Z')]);
  r.tick();
  assert.equal(r.ran(), false);
  assert.match(r.log(), stopAgentsPaused);
  r.gh.json('stop-events.json', stopAgentsLifted['unlabelled by the owner']);
  assert.equal(r.tick({}, ['--plan']).trim(), 'ticket 7');
});

test("past the 300 pages of events GitHub serves, the owner's stop-agents the App unlabelled still pauses, and the record is written", t => {
  const r = ticketSetup(t);
  serveStopAgents(r, stopAgentsCases['unlabelled by the App'], [repoEvent(9, 'unlabeled', 'example-agents[bot]', 'stop-agents'),
    ...Array.from({length: 99}, () => repoEvent(3, 'labeled', 'Example-Owner', 'bug'))]);
  r.gh.respond({[`${repoEventsCall}?per_page=100&page=301`]:
    {stderr: 'gh: Pagination is limited for this resource. (HTTP 422)\n', exit: 1}});
  assert.match(r.tick({}, ['--plan']), stopAgentsPaused);
  assert.equal(r.ghCalls().filter(call => call.join(' ').startsWith(repoEventsCall)).length, 300);
  assert.equal(readFileSync(join(r.root, 'state/ticket-runner/stop-agents-events'), 'utf8'), '2026-10-17T10:00:00Z\n9\n');
});

test("the owner's stop-agents the App closed pauses while its label is on, though its labeled event is past the events read", t => {
  const r = ticketSetup(t);
  serveStopAgents(r, stopAgentsCases['closed by the App'], [repoEvent(3, 'labeled', 'Example-Owner', 'bug')]);
  r.gh.respond({[`issue list -R ${repo} --label stop-agents --state all`]: {stdout: '9\n'}});
  assert.match(r.tick({}, ['--plan']), stopAgentsPaused);
});

test('a failed read of the issues labelled stop-agents pauses the project', t => {
  const r = ticketSetup(t);
  serveStopAgents(r, stopAgentsLifted['closed by the owner']);
  r.gh.respond({[`issue list -R ${repo} --label stop-agents --state all`]: failedRead});
  r.tick();
  assert.equal(r.ran(), false);
  assert.match(r.log(), /paused: the stop-agents events of Example-Owner\/example-project, which could not be read/);
});

test('a failed read of the stop-agents events pauses the project', t => {
  for (const routes of [{[repoEventsCall]: failedRead}, {[eventsCall(9)]: failedRead}]) {
    const r = ticketSetup(t);
    serveStopAgents(r, stopAgentsCases['closed by the App']);
    r.gh.respond(routes);
    r.tick();
    assert.equal(r.ran(), false);
    assert.match(r.log(), /could not read the stop-agents events of Example-Owner\/example-project/);
    assert.match(r.log(), /paused: the stop-agents events of Example-Owner\/example-project, which could not be read/);
  }
});

test("the owner's stop-agents the App closed, or a failed read of its events, ends a session in progress", t => {
  for (const [routes, reason] of [[{[eventsCall(9)]: {file: 'stop-events.json'}},
    "issue #9, under the owner's stop-agents, which only the owner's unlabelling or closing lifts"],
  [{[eventsCall(9)]: failedRead}, 'the stop-agents events of \\S+, which could not be read']]) {
    const r = ticketSetup(t);
    r.gh.json('repo-events.json', stopAgentsBy('Example-Owner'));
    r.gh.json('stop-events.json', stopAgentsCases['closed by the App']);
    brakeSession(r)({BRAKE_ROUTES: {[repoEventsCall]: {file: 'repo-events.json'}, ...routes}});
    assertBrakeEnded(r, reason);
  }
});

test('with no brake a session checked while it runs ends as before, and its watcher ends with it', t => {
  const r = ticketSetup(t);
  r.gh.json('open-7.json', issue(7, {labels: ['agent-working']}));
  r.gh.respond({[issueView(7)]: {file: 'open-7.json'}});
  brakeSession(r)({SESSION_SECONDS: '1'});
  const log = r.log();
  assert.ok(r.ghCalls().filter(call => call.join(' ').startsWith(issueView(7))).length >= 2, 'the brakes were checked');
  assert.doesNotMatch(log, /owner's brake|could not look up/);
  assert.match(log, /ticket #7: run 1 ended without progress \(exit 0\)/);
  assert.equal(readFileSync(join(r.root, 'state/ticket-runner/attempts/ticket-7'), 'utf8').trim(), '1');
  assert.deepEqual(r.securityCalls(), [], 'no pull request to review');
  const calls = r.ghCalls().length;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  assert.equal(r.ghCalls().length, calls, 'nothing checks the brakes after the run');
});

test('a brake interval that is not a positive number of seconds, or a grace period that is not whole, stops the runner before any gh call', t => {
  const r = ticketSetup(t);
  for (const env of [{TICKET_RUNNER_BRAKE_SECONDS: '1m'}, {TICKET_RUNNER_BRAKE_SECONDS: '0'},
    {TICKET_RUNNER_BRAKE_SECONDS: '0.0'}, {TICKET_RUNNER_BRAKE_GRACE_SECONDS: '0.5'}]) {
    assert.throws(() => r.tick(env), error => error.status === 2 && /TICKET_RUNNER_BRAKE_SECONDS must be/.test(error.stderr));
  }
  assert.deepEqual(r.ghCalls(), []);
});

test('a runner stopped while its session runs stops the session and its processes too, and removes its label', t => {
  const r = ticketSetup(t);
  const script = join(r.root, 'stop-runner');
  writeFileSync(script, `#!/bin/sh
sh -c 'trap "" TERM; sleep 30' & echo $! > "$PROBE/session-child"
kill -TERM "$(sed -n 's/^pid //p' "$PROBE/current")"
wait
`, {mode: 0o755});
  assert.throws(() => r.tick({...brakeEnv, DURING_SESSION: script}), error => error.status === 143);
  assert.equal(alive(Number(r.probe('session-child'))), false);
  assert.equal(existsSync(r.current), false);
  assert.deepEqual(labelCalls(r.ghCalls()).slice(-1), [`issue edit 7 -R ${repo} --remove-label agent-working`]);
});

// Writes a program a session runs through $DURING_SESSION.
function sessionScript(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}`, {mode: 0o755});
  return file;
}
// Whether a project's tick claimed anything: labelled an issue agent-working or opened one.
const claimed = p => labelCalls(p.ghCalls()).length > 0 || p.creates().length > 0;

test('without max-sessions, a run in one project makes another project with a run to start exit, claiming nothing', t => {
  const {a, b, sharedDir} = twoProjects(t);
  a.tick({DURING_SESSION: b.tickCommand()});
  assert.equal(existsSync(join(sharedDir, 'max-sessions')), false, 'no script writes max-sessions');
  assert.equal(a.runs(), 1);
  assert.equal(b.ran(), false);
  assert.equal(claimed(b), false);
  assert.doesNotMatch(b.log(), /max-sessions/);
});

test('with max-sessions at 2, two projects run at once and a third exits, claiming nothing', t => {
  const p = projects(t, {a: [issue(7)], b: [issue(7)], c: [issue(7)]});
  p.maxSessions('2\n');
  p.a.tick({DURING_SESSION: p.b.tickCommand({DURING_SESSION: p.c.tickCommand()})});
  assert.equal(p.a.runs(), 1);
  assert.equal(p.b.runs(), 1, 'b started its run while a ran');
  assert.equal(p.c.ran(), false, 'every slot was taken');
  assert.equal(claimed(p.c), false);
  assert.ok(existsSync(join(p.sharedDir, 'waiting/c')), 'c marked itself waiting');
});

test('a second tick of a project whose run is in progress never starts a run, whatever max-sessions is', t => {
  const p = projects(t, {a: [issue(7), issue(8)]});
  p.maxSessions('3\n');
  p.a.tick({DURING_SESSION: p.a.tickCommand()});
  assert.equal(p.a.runs(), 1);
  assert.equal(labelCalls(p.a.ghCalls()).filter(call => call.includes('--add-label')).length, 1);
});

test('with a free slot the project that ran last runs despite a fresh waiting mark; with every slot taken it yields', t => {
  const free = twoProjects(t);
  free.maxSessions('2\n');
  free.a.tick();
  writeFileSync(join(free.sharedDir, 'waiting/b'), `${Math.floor(Date.now() / 1000)}\n`);
  free.a.tick();
  assert.equal(free.a.runs(), 2);
  assert.doesNotMatch(free.a.log(), /yielding/);

  const full = projects(t, {a: [issue(7)], b: [issue(7)], c: [issue(7)]});
  full.maxSessions('2\n');
  // During c's run, a ran last and b is waiting; a's tick takes the last free slot.
  full.c.tick({DURING_SESSION: sessionScript(full.root, 'a-last', `printf 'a\\n' > '${join(full.sharedDir, 'last')}'
date +%s > '${join(full.sharedDir, 'waiting/b')}'
exec '${full.a.tickCommand()}'
`)});
  assert.equal(full.c.runs(), 1);
  assert.equal(full.a.runs(), 0);
  assert.match(full.a.log(), /ticket #7: a ran last and b is waiting; yielding this turn to it/);
});

test('a max-sessions that is not a whole number of at least 1 counts as 1, and the tick logs that it ignored it', t => {
  for (const text of ['0\n', '-1\n', 'two\n', '\n']) {
    const {a, b, maxSessions} = twoProjects(t);
    maxSessions(text);
    a.tick({DURING_SESSION: b.tickCommand()});
    assert.equal(a.runs(), 1, JSON.stringify(text));
    assert.equal(b.ran(), false, JSON.stringify(text));
    assert.equal(claimed(b), false, JSON.stringify(text));
    assert.match(b.log(), /ignored \S+\/max-sessions, which is not a whole number of at least 1; running one session at a time/,
      JSON.stringify(text));
  }
});

test('a run killed mid-session frees its slot for a later tick', t => {
  const p = projects(t, {a: [issue(7)], b: [issue(7)], c: [issue(7)]});
  p.maxSessions('2\n');
  // As systemd kills a unit's processes: the runner, its brake watcher and the session.
  const kill = sessionScript(p.root, 'kill-run', `pid="$(sed -n 's/^pid //p' '${p.a.current}')"
pkill -KILL -P "$pid"
kill -KILL "$pid"
`);
  // A killed runner's EXIT trap never runs, so its temporary directory goes under the test's root, which the test removes.
  const scratch = join(p.root, 'tmp');
  mkdirSync(scratch);
  // Short sleeps, as an orphaned watcher's or token refresher's sleep holds the tick's output open until it ends.
  assert.throws(() => p.a.tick({...brakeEnv, TICKET_RUNNER_TOKEN_SECONDS: '0.1', DURING_SESSION: kill, TMPDIR: scratch}),
    error => error.signal === 'SIGKILL');
  assert.equal(p.a.runs(), 1);
  p.b.tick({DURING_SESSION: p.c.tickCommand()});
  assert.equal(p.b.runs(), 1);
  assert.equal(p.c.runs(), 1, "a's slot was free again");
});

test('with max-sessions above 1 the shared stop file and the shared backoff still pause every project', t => {
  const stopped = twoProjects(t);
  stopped.maxSessions('2\n');
  writeFileSync(join(stopped.sharedDir, 'stop'), '');
  stopped.a.tick();
  stopped.b.tick();
  assert.equal(stopped.a.ran(), false);
  assert.equal(stopped.b.ran(), false);

  const backedOff = twoProjects(t);
  backedOff.maxSessions('2\n');
  writeFileSync(join(backedOff.sharedDir, 'backoff'), `${Math.floor(Date.now() / 1000) + 3600}\n`);
  backedOff.a.tick();
  backedOff.b.tick();
  assert.equal(backedOff.a.ran(), false);
  assert.equal(backedOff.b.ran(), false);
});
