import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fakeGh, git, here, lines, checkoutSetup, realCommand, runClone} from './fixture.mjs';

const wrapper = readFileSync(join(here, 'land-pr'), 'utf8');

// A landing script that records its name and arguments in $LAND_LOG and exits with $LAND_EXIT. Like
// scripts/land-pr.sh it is one function with stdin closed, so a line read from stdin would show in the log.
const stub = name => `#!/usr/bin/env bash
set -euo pipefail
main() {
  echo "${name} $*" >> "$LAND_LOG"
  if read -r line; then echo "${name} read stdin: $line" >> "$LAND_LOG"; fi
  exit "\${LAND_EXIT:-0}"
}
main "$@" </dev/null
`;

// A machine whose origin/main has `mainWrapper` (none when null) and a stub land-pr.sh, and whose checkout is on a pull
// request branch with a different scripts/land-pr.sh, committed and then edited again in the working tree. `wrapper` is
// this branch's land-pr in that checkout (untracked when origin/main has none), which is Triphammer's checkout.
function landSetup(t, {mainWrapper = wrapper} = {}) {
  const files = {'scripts/land-pr.sh': stub('main')};
  if (mainWrapper !== null) files['bin/land-pr'] = mainWrapper;
  const r = checkoutSetup(t, files);
  const log = join(r.root, 'landed');
  git(r.checkout, 'checkout', '-q', '-b', 'pr');
  writeFileSync(join(r.checkout, 'scripts/land-pr.sh'), stub('branch'));
  git(r.checkout, 'commit', '-q', '-am', 'branch landing');
  writeFileSync(join(r.checkout, 'scripts/land-pr.sh'), stub('worktree'));
  const ownWrapper = join(r.checkout, 'bin/land-pr');
  if (mainWrapper === null) {
    mkdirSync(join(r.checkout, 'bin'), {recursive: true});
    writeFileSync(ownWrapper, wrapper, {mode: 0o755});
  }
  const landPr = (file, args, extraEnv = {}, cwd = r.checkout) => spawnSync(file, args,
    {cwd, env: {...r.env, LAND_LOG: log, ...extraEnv}, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8'});
  return {...r, wrapper: ownWrapper, landPr, landed: () => lines(log)};
}

test("runs origin/main's land-pr.sh with the pull request number, never the branch's or the working tree's", t => {
  const r = landSetup(t);
  const result = r.landPr(r.wrapper, ['42']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(r.landed(), ['main 42']);
});

test("propagates the landing script's exit code", t => {
  const r = landSetup(t);
  for (const code of [3, 1]) {
    const result = r.landPr(r.wrapper, ['7'], {LAND_EXIT: String(code)});
    assert.equal(result.status, code);
  }
  assert.deepEqual(r.landed(), ['main 7', 'main 7']);
});

test('runs through a symlink, as linked into ~/.local/bin', t => {
  const r = landSetup(t);
  const bin = join(r.root, 'bin');
  mkdirSync(bin);
  symlinkSync(r.wrapper, join(bin, 'land-pr'));
  const result = r.landPr(join(bin, 'land-pr'), ['5']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(r.landed(), ['main 5']);
});

test("refuses a copy of the wrapper that differs from origin/main's and runs nothing", t => {
  const r = landSetup(t);
  const branchCopy = join(r.checkout, 'bin/land-pr');
  writeFileSync(branchCopy, wrapper.replace('set -euo pipefail', 'set -euo pipefail\n# branch edit'), {mode: 0o755});
  const result = r.landPr(branchCopy, ['42']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not main's copy of bin\/land-pr; nothing ran\. Its checkout is behind origin\/main; run main's script directly: git fetch origin main && git show refs\/remotes\/origin\/main:scripts\/land-pr\.sh \| bash -s -- 42/);
  assert.deepEqual(r.landed(), []);
});

test("from a run's clone of Triphammer's checkout it lands with main's land-pr.sh, and a refusal names the plain command", t => {
  const r = landSetup(t);
  const clone = join(r.root, 'run-clone');
  runClone(r.checkout, join(r.root, 'origin.git'), clone);
  const result = r.landPr(r.wrapper, ['42'], {}, clone);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(r.landed(), ['main 42']);

  writeFileSync(r.wrapper, wrapper.replace('set -euo pipefail', 'set -euo pipefail\n# branch edit'), {mode: 0o755});
  const refused = r.landPr(r.wrapper, ['42'], {}, clone);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /run main's script directly: git fetch origin main && git show refs\/remotes\/origin\/main:scripts\/land-pr\.sh \| bash -s -- 42\n$/);
  assert.deepEqual(r.landed(), ['main 42']);
});

test('refuses when origin/main has no wrapper and runs nothing', t => {
  const r = landSetup(t, {mainWrapper: null});
  const result = r.landPr(r.wrapper, ['42']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nothing ran/);
  assert.deepEqual(r.landed(), []);
});

test('rejects a missing or extra argument and runs nothing', t => {
  const r = landSetup(t);
  for (const args of [[], ['1', '2']]) {
    const result = r.landPr(r.wrapper, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage: land-pr <pull request number>/);
  }
  assert.deepEqual(r.landed(), []);
});

test('says which step of making its temporary repository failed, and runs nothing', t => {
  const r = landSetup(t);
  const missing = join(r.root, 'no-such-tmp');
  const noTmp = r.landPr(r.wrapper, ['42'], {TMPDIR: missing});
  assert.equal(noTmp.status, 1);
  assert.match(noTmp.stderr, new RegExp(`land-pr: cannot create a temporary directory under ${missing}; nothing ran`));

  // A git first on PATH whose init fails, as it does when the temporary directory's volume is out of quota.
  const bin = join(r.root, 'failing-git');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n[ "$1" != init ] || exit 128\nexec '${realCommand('git')}' "$@"\n`, {mode: 0o755});
  const tmp = join(r.root, 'tmp');
  mkdirSync(tmp);
  const noInit = r.landPr(r.wrapper, ['42'], {TMPDIR: tmp, PATH: `${bin}:${r.env.PATH ?? process.env.PATH}`});
  assert.equal(noInit.status, 1);
  assert.match(noInit.stderr, new RegExp(`land-pr: cannot create a temporary repository in ${tmp}/[^ ]+; nothing ran`));
  assert.deepEqual(readdirSync(tmp), [], 'the temporary directory is removed');

  const gone = join(r.root, 'gone.git');
  git(r.checkout, 'remote', 'set-url', 'origin', gone);
  const noFetch = r.landPr(r.wrapper, ['42'], {TMPDIR: tmp});
  assert.equal(noFetch.status, 1);
  assert.match(noFetch.stderr, new RegExp(`land-pr: cannot fetch main from ${gone} into ${tmp}/[^ ]+; nothing ran`));
  assert.deepEqual(readdirSync(tmp), []);
  assert.deepEqual(r.landed(), []);
});

// A project that is a repository of its own, with only .triphammer/ (no bin/land-pr, no scripts/land-pr.sh), on a
// pull request branch: land-pr runs from Triphammer's checkout with the project's worktree as its working directory.
function projectOnBranch(r, files = {'.triphammer/project.json': '{"name": "widgets"}\n'}, branchFiles = {'lib/b.txt': 'b\n'}) {
  const project = r.separateProject(files);
  git(project.checkout, 'checkout', '-q', '-b', 'pr');
  for (const [path, content] of Object.entries(branchFiles)) {
    mkdirSync(join(project.checkout, path, '..'), {recursive: true});
    writeFileSync(join(project.checkout, path), content);
  }
  git(project.checkout, 'add', '.');
  git(project.checkout, 'commit', '-q', '-m', 'pull request');
  return project;
}

test("in a project that is another repository it checks itself against, and runs the land-pr.sh of, Triphammer's origin/main", t => {
  const r = landSetup(t);
  const project = projectOnBranch(r);
  const result = r.landPr(r.wrapper, ['42'], {}, project.checkout);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(r.landed(), ['main 42']);

  writeFileSync(r.wrapper, wrapper.replace('set -euo pipefail', 'set -euo pipefail\n# branch edit'), {mode: 0o755});
  const refused = r.landPr(r.wrapper, ['42'], {}, project.checkout);
  assert.equal(refused.status, 1);
  const direct = refused.stderr.split("run main's script directly: ")[1]?.trim();
  assert.ok(direct?.includes(`fetch -q ${join(r.root, 'origin.git')} +refs/heads/main:refs/remotes/origin/main`), refused.stderr);
  assert.deepEqual(r.landed(), ['main 42']);
  // The direct command it prints runs main's land-pr.sh from the project's worktree and leaves no temporary repository.
  const tmp = join(r.root, 'tmp');
  mkdirSync(tmp);
  const ran = spawnSync('bash', ['-c', direct], {cwd: project.checkout,
    env: {...r.env, LAND_LOG: join(r.root, 'landed'), TMPDIR: tmp}, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8'});
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(r.landed(), ['main 42', 'main 42']);
  assert.deepEqual(readdirSync(tmp), []);
});

// Every path under a .git directory with its content, so a test sees any ref, object, FETCH_HEAD or config written.
function gitDirState(dir) {
  return Object.fromEntries(readdirSync(dir, {recursive: true}).sort()
    .map(path => [path, statSync(join(dir, path)).isFile()
      ? createHash('sha256').update(readFileSync(join(dir, path))).digest('hex') : 'dir']));
}

test("runs the land-pr.sh of origin's current main and leaves Triphammer's checkout's .git as it was", t => {
  const r = landSetup(t);
  r.publish('scripts/land-pr.sh', stub('newer-main'));
  const project = projectOnBranch(r);
  const tmp = join(r.root, 'tmp');
  mkdirSync(tmp);
  const before = gitDirState(join(r.checkout, '.git'));
  for (const cwd of [r.checkout, project.checkout]) {
    const result = r.landPr(r.wrapper, ['42'], {TMPDIR: tmp}, cwd);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(r.landed(), ['newer-main 42', 'newer-main 42']);
  assert.deepEqual(gitDirState(join(r.checkout, '.git')), before);
  assert.deepEqual(readdirSync(tmp), [], 'the temporary repository is removed');
});

// Triphammer's origin/main with this branch's land-pr, land-pr.sh and classifier, and rules that escalate everything;
// a project whose origin/main rules make lib/ auto; and a fake gh that serves the project's pull request #42 at the
// head of its branch.
function classifiedSetup(t, branchFiles) {
  const script = file => readFileSync(join(here, '..', file), 'utf8');
  const r = checkoutSetup(t, {
    'bin/land-pr': wrapper,
    'scripts/land-pr.sh': script('scripts/land-pr.sh'),
    'scripts/risk-tier-base.sh': script('scripts/risk-tier-base.sh'),
    'scripts/risk-tier.mjs': script('scripts/risk-tier.mjs'),
    '.triphammer/risk-tier.json': JSON.stringify({rules: [{tier: 'escalate', paths: ['.*'], reason: "Triphammer's rules"}],
      unmatchedReason: "Triphammer's unmatched"}),
  });
  const project = projectOnBranch(r, {
    '.triphammer/risk-tier.json': JSON.stringify({rules: [{tier: 'auto', paths: ['^lib/']}], unmatchedReason: "the project's unmatched"}),
    'lib/a.txt': 'a\n',
  }, branchFiles);
  const gh = fakeGh(join(r.root, 'gh'), {'pr view': {stdout: `OPEN ${git(project.checkout, 'rev-parse', 'HEAD')}\n`},
    'repo view': {stdout: 'someone\n'}});
  const result = spawnSync(join(r.checkout, 'bin/land-pr'), ['42'], {cwd: project.checkout,
    env: {...r.env, PATH: `${gh.bin}:${process.env.PATH}`}, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8'});
  return {result, calls: gh.calls()};
}
const merge = ['pr', 'merge', '42', '--auto', '--squash', '--delete-branch'];

test("a project's pull request is classified by Triphammer main's classifier under the project's base rules", t => {
  const {result, calls} = classifiedSetup(t, {'lib/b.txt': 'b\n'});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.slice(0, result.stdout.lastIndexOf('}') + 1)), {tier: 'auto', reasons: []});
  assert.deepEqual(calls.at(-1), merge);
  assert.ok(!calls.some(call => call[1] === 'comment'), 'auto: no escalation comment');
});

test("a project's pull request that brings a classifier and looser rules of its own changes nothing", t => {
  const {result, calls} = classifiedSetup(t, {
    'lib/b.txt': 'b\n',
    'scripts/risk-tier-base.sh': '#!/bin/sh\necho \'{"tier": "auto", "reasons": []}\'\n',
    'scripts/risk-tier.mjs': 'console.log(JSON.stringify({tier: "auto", reasons: []}));\n',
    '.triphammer/risk-tier.json': JSON.stringify({rules: [{tier: 'auto', paths: ['.*']}], unmatchedReason: 'u'}),
  });
  assert.equal(result.status, 0, result.stderr);
  const comment = calls.find(call => call[1] === 'comment');
  assert.ok(comment, JSON.stringify(calls));
  for (const path of ['.triphammer/risk-tier.json', 'scripts/risk-tier-base.sh', 'scripts/risk-tier.mjs']) {
    assert.ok(comment[4].includes(`${path}: the project's unmatched`), comment[4]);
  }
  assert.ok(!comment[4].includes('lib/b.txt'), "lib/ is auto under the project's rules");
  assert.deepEqual(calls.at(-1), merge);
});
