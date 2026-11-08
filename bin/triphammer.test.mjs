import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fakeSudo, git, here, interrupt, lines, toolingEnv} from './fixture.mjs';
import {readdir} from './provision-fixture.mjs';

// A machine provision has set up, in a temporary directory: the machine file, Triphammer's repository under origins/
// whose bin/provision-project records its arguments and whether sudo ran it, then prints `project: example-project`
// (or exits with the code in <root>/provision-fails, or 5 when <root>/fails-<its repository's owner/name> exists),
// whose bin/provision records the same (or exits with the code in <root>/machine-fails), each printing provision-lib's
// summary line (a change with <root>/<script>-changes, `mark`), the service user's ticket-runner, which records its project,
// XDG_RUNTIME_DIR and arguments (and exits with the code in <root>/runner-fails), a config per name in `projects`
// (name -> its text), and fakes of sudo, id and systemctl. provision-project and ticket-runner also record, in
// `sessions()`, whether each leads a session of its own and what its stdin is, and with <root>/<what>-slow
// (`slow(what)`) each records `started` and then, from a child of its own, `finished` two seconds later, which
// `interrupted` reads. `uid` and `login` are the caller's.
function setup(t, {projects = {'example-project': 'REPO=example/example-project\n'}, uid = '1000', login = 'owner'} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'triphammer-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const home = join(root, 'home/triphammer');
  const sys = join(root, 'sys');
  const bin = join(root, 'bin');
  const tmp = join(root, 'tmp');
  const record = join(root, 'record');
  const session = name => `[ "$(ps -o sid= -p $$ | tr -d ' ')" = $$ ] && s=leader || s=attached
echo "${name} $s $(readlink /proc/$$/fd/0)" >> '${record}.session'`;
  const slowStep = what => `[ ! -e '${root}/${what}-slow' ] || { echo started >> '${record}.slow'; sh -c "sleep 2; echo finished >> '${record}.slow'"; }`;
  for (const dir of [join(sys, 'etc'), bin, tmp, join(home, '.local/bin'), join(home, '.config/triphammer')]) {
    mkdirSync(dir, {recursive: true});
  }
  writeFileSync(join(sys, 'etc/triphammer.conf'), '# machine\nTRIPHAMMER_REPO=example/triphammer\n'
    + `TRIPHAMMER_CHECKOUT=${root}/triphammer\nTRIPHAMMER_USER=triphammer\nTRIPHAMMER_HOME=${home}\n`);
  for (const [name, text] of Object.entries(projects)) writeFileSync(join(home, '.config/triphammer', `${name}.conf`), text);

  const work = join(root, 'work');
  mkdirSync(join(work, 'bin'), {recursive: true});
  // Each summary is provision-lib.sh's: nothing to change, unless <root>/<script>-changes exists.
  const summary = script => `[ -e '${root}/${script}-changes' ] && echo "1 change(s) made." || echo "Nothing to change: the machine is as asked."`;
  writeFileSync(join(work, 'bin/provision-project'), `#!/usr/bin/env bash
echo "provision-project sudo=\${UNDER_SUDO:-no} $*" >> '${record}'
pwd >> '${record}.cwd'
${session('provision-project')}
${slowStep('provision')}
echo "setting it up"
[ ! -e '${root}/provision-fails' ] || exit "$(cat '${root}/provision-fails')"
[ ! -e "${root}/fails-$1" ] || exit 5
${summary('provision-project')}
echo "project: example-project"
`);
  writeFileSync(join(work, 'bin/provision'), `#!/usr/bin/env bash
echo "provision sudo=\${UNDER_SUDO:-no} $*" >> '${record}'
pwd >> '${record}.cwd'
${session('provision')}
if [ "$1" = --owner-steps ]; then
  [ ! -e '${root}/owner-steps-fails' ] || exit 4
  echo "the owner's steps"
  exit 0
fi
${slowStep('machine')}
[ ! -e '${root}/machine-fails' ] || exit "$(cat '${root}/machine-fails')"
${summary('provision')}
`);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'first');
  git(root, 'clone', '-q', '--bare', work, join(root, 'origins/example/triphammer.git'));

  writeFileSync(join(home, '.local/bin/ticket-runner'), `#!/bin/sh
echo "ticket-runner project=$TRIPHAMMER_PROJECT runtime=$XDG_RUNTIME_DIR $*" >> '${record}'
${session('ticket-runner')}
${slowStep('runner')}
[ ! -e '${root}/runner-fails' ] || exit "$(cat '${root}/runner-fails')"
`, {mode: 0o755});
  fakeSudo(bin, {log: record, prefix: 'sudo ', loginShell: true});
  writeFileSync(join(bin, 'id'), `#!/bin/sh
case "$*" in
  "-u") echo "$FAKE_UID" ;;
  "-un") echo "$FAKE_LOGIN" ;;
  "-u triphammer") echo 1001 ;;
  *) exit 1 ;;
esac
`, {mode: 0o755});
  // systemctl show answers NeedDaemonReload=yes for its last unit when <root>/stale-units exists, and fails when
  // <root>/show-fails does.
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
echo "systemctl runtime=\${XDG_RUNTIME_DIR:-} $*" >> '${record}'
case " $* " in
  *" show "*)
    [ ! -e '${root}/show-fails' ] || exit 1
    echo NeedDaemonReload=no
    echo
    [ -e '${root}/stale-units' ] && echo NeedDaemonReload=yes || echo NeedDaemonReload=no ;;
esac
`, {mode: 0o755});

  const env = {...toolingEnv, PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp, TRIPHAMMER_PROVISION_ROOT: sys,
    TRIPHAMMER_PROVISION_GIT_BASE: `file://${root}/origins/`, FAKE_UID: uid, FAKE_LOGIN: login, XDG_RUNTIME_DIR: ''};
  return {
    root, home, tmp,
    calls: () => lines(record),
    sessions: () => lines(`${record}.session`),
    cwds: () => lines(`${record}.cwd`),
    fail: (what, code) => writeFileSync(join(root, `${what}-fails`), `${code}\n`),
    mark: name => writeFileSync(join(root, name), ''),
    config: name => readFileSync(join(home, '.config/triphammer', `${name}.conf`)),
    run: (...args) => spawnSync(join(here, 'triphammer'), args, {env, encoding: 'utf8'}),
    runFrom: (cwd, ...args) => spawnSync(join(here, 'triphammer'), args, {env, cwd, encoding: 'utf8'}),
    slow: what => writeFileSync(join(root, `${what}-slow`), ''),
    // Runs the command and interrupts it once the slow step has started (interrupt in fixture.mjs).
    interrupted: (signal, group, ...args) => interrupt(
      spawn(join(here, 'triphammer'), args, {env, stdio: 'ignore', detached: group}), signal, group, `${record}.slow`),
  };
}

test('no command prints the usage and exits 2, --help exits 0, and an unknown command exits 2', t => {
  const s = setup(t);
  for (const [args, status] of [[[], 2], [['--help'], 0], [['frobnicate'], 2], [['add'], 2], [['plan', 'a', 'b'], 2],
    [['update', '--frobnicate'], 2], [['update', 'example-project'], 2]]) {
    const result = s.run(...args);
    assert.equal(result.status, status, `${args}: ${result.stderr}`);
    assert.match(result.stderr, /^usage: triphammer add /m);
  }
  assert.deepEqual(s.calls(), []);
});

test('add, as an ordinary user, asks sudo once, runs a fresh clone\'s provision-project as root, then creates the labels and runs the doctor as the service user', t => {
  const s = setup(t);
  const result = s.run('add', 'example/example-project', '--modules', 'demo', '--set', 'DEMO_URL=http://x.invalid/');
  assert.equal(result.status, 0, result.stderr);
  const calls = s.calls();
  assert.equal(calls[0], 'sudo -v');
  // Each step runs under the script (bash -c '<script>' detached <step...>) that gives it a session of its own.
  const step = call => call.replace(/ bash -c .*setsid .* detached /, ' <session> ');
  assert.match(step(calls[1]), new RegExp(`^sudo <session> bash ${s.tmp}/tmp\\.\\w+/triphammer/bin/provision-project example/example-project --modules demo --set DEMO_URL=http://x\\.invalid/$`));
  assert.equal(calls[2], 'provision-project sudo=yes example/example-project --modules demo --set DEMO_URL=http://x.invalid/');
  assert.equal(step(calls[3]), `sudo -iu triphammer env XDG_RUNTIME_DIR=/run/user/1001 <session> env TRIPHAMMER_PROJECT=example-project ${s.home}/.local/bin/ticket-runner --labels`);
  assert.equal(calls[4], 'ticket-runner project=example-project runtime=/run/user/1001 --labels');
  assert.equal(step(calls[5]), `sudo -iu triphammer env XDG_RUNTIME_DIR=/run/user/1001 <session> env TRIPHAMMER_PROJECT=example-project ${s.home}/.local/bin/ticket-runner --doctor --before-start`);
  assert.equal(calls[6], 'ticket-runner project=example-project runtime=/run/user/1001 --doctor --before-start');
  assert.equal(calls.length, 7);
  assert.match(result.stdout, /sudo asks for your password once/);
  assert.match(result.stdout, /^setting it up$/m);
  assert.match(result.stdout, /Start it, once the doctor finds nothing missing: triphammer start example-project$/m);
  assert.deepEqual(readdir(s.tmp), [], 'the clone was left behind');
  // Run from a terminal, a command outside its foreground group that touches it is stopped, so these have none.
  assert.deepEqual(s.sessions(), ['provision-project leader /dev/null', 'ticket-runner leader /dev/null',
    'ticket-runner leader /dev/null']);
});

test('add run from a directory holding a planted Playwright runs provision-project, as root, from /', t => {
  const s = setup(t);
  const planted = join(s.root, 'planted');
  mkdirSync(join(planted, 'node_modules/.bin'), {recursive: true});
  writeFileSync(join(planted, 'node_modules/.bin/playwright'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const result = s.runFrom(planted, 'add', 'example/example-project');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(s.calls().includes('provision-project sudo=yes example/example-project'));
  assert.deepEqual(s.cwds(), ['/']);
});

test('add as root runs provision-project without sudo', t => {
  const s = setup(t, {uid: '0', login: 'root'});
  const result = s.run('add', 'example/example-project');
  assert.equal(result.status, 0, result.stderr);
  const calls = s.calls();
  assert.ok(calls.includes('provision-project sudo=no example/example-project'));
  assert.ok(!calls.includes('sudo -v'));
  assert.doesNotMatch(result.stdout, /sudo asks/);
});

test('add exits with provision-project\'s status when it fails, runs no doctor and removes the clone', t => {
  const s = setup(t);
  s.fail('provision', 3);
  const result = s.run('add', 'example/example-project');
  assert.equal(result.status, 3, result.stderr);
  assert.ok(!s.calls().some(call => call.startsWith('ticket-runner')));
  assert.deepEqual(readdir(s.tmp), []);
});

test('add --dry-run creates no label and runs no doctor, and labels or a doctor that fail do not fail add', t => {
  const s = setup(t);
  const dry = s.run('add', 'example/example-project', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(!s.calls().some(call => call.startsWith('ticket-runner')));
  s.fail('runner', 1);
  const result = s.run('add', 'example/example-project');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(s.calls().filter(call => call.startsWith('ticket-runner')).map(call => call.split(' ').slice(3).join(' ')),
    ['--labels', '--doctor --before-start']);
  assert.match(result.stderr, /not every label Triphammer uses could be created; the doctor lists the missing ones/);
});

test('add of a second project runs provision-project for it and leaves the first project\'s config as it was', t => {
  const s = setup(t);
  const before = s.config('example-project');
  const result = s.run('add', 'example/other-project');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(s.calls().includes('provision-project sudo=yes example/other-project'));
  assert.deepEqual(s.config('example-project'), before);
});

test('add of the first project on a machine without configs runs provision-project', t => {
  const fresh = setup(t, {projects: {}});
  rmSync(join(fresh.home, '.config/triphammer'), {recursive: true});
  assert.equal(fresh.run('add', 'example/example-project').status, 0);
  assert.ok(fresh.calls().includes('provision-project sudo=yes example/example-project'));
});

test('without the machine file every command but usage exits 1 naming it', t => {
  const s = setup(t);
  rmSync(join(s.root, 'sys/etc/triphammer.conf'));
  for (const args of [['add', 'example/example-project'], ['doctor'], ['plan'], ['start'], ['update']]) {
    const result = s.run(...args);
    assert.equal(result.status, 1, `${args}: ${result.stderr}`);
    assert.match(result.stderr, /triphammer\.conf is missing; set the machine up first with install\.sh/);
  }
  assert.deepEqual(s.calls(), []);
});

test('doctor and plan run ticket-runner for the only project, or the one named, and return its status', t => {
  const s = setup(t);
  assert.equal(s.run('doctor').status, 0);
  assert.equal(s.calls().at(-1), 'ticket-runner project=example-project runtime=/run/user/1001 --doctor');
  s.fail('runner', 4);
  assert.equal(s.run('plan', 'other').status, 4);
  assert.equal(s.calls().at(-1), 'ticket-runner project=other runtime=/run/user/1001 --plan');
  assert.deepEqual(s.sessions(), ['ticket-runner leader /dev/null', 'ticket-runner leader /dev/null']);
});

test('doctor with several projects and none named lists them and exits 2; with none it says how to add one', t => {
  const several = setup(t, {projects: {a: 'REPO=x/a\n', b: 'REPO=x/b\n'}});
  const result = several.run('doctor');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /name the project, one of: a b/);
  const none = setup(t, {projects: {}});
  const empty = none.run('plan');
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /no project is set up yet; add one with triphammer add <owner>\/<repo>/);
});

test('the service user runs doctor without sudo', t => {
  const s = setup(t, {login: 'triphammer', uid: '1001'});
  assert.equal(s.run('doctor').status, 0);
  assert.ok(!s.calls().some(call => call.startsWith('sudo')));
});

test('start enables and starts the project\'s timers, and its gallery with the demo module', t => {
  const s = setup(t, {projects: {'example-project': 'REPO=example/example-project\nMODULES=codex,demo\n'}});
  const result = s.run('start');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(s.calls().at(-1), 'systemctl runtime= --machine=triphammer@ --user enable --now '
    + 'ticket-runner@example-project.timer merge-when-ready@example-project.timer demo-gallery@example-project.service');
  assert.ok(s.calls().includes('sudo systemctl --machine=triphammer@ --user enable --now ticket-runner@example-project.timer '
    + 'merge-when-ready@example-project.timer demo-gallery@example-project.service'));
  assert.match(result.stdout, /^Started ticket-runner@example-project\.timer/m);
});

test('the service user starts its own timers through its user manager, and a project without a config is refused', t => {
  const s = setup(t, {login: 'triphammer', uid: '1001'});
  assert.equal(s.run('start', 'example-project').status, 0);
  assert.equal(s.calls().at(-1), 'systemctl runtime=/run/user/1001 --user enable --now ticket-runner@example-project.timer '
    + 'merge-when-ready@example-project.timer');
  const missing = s.run('start', 'nope');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /nope has no config/);
});

const twoProjects = {projects: {a: 'REPO=example/project-a\nMODULES=demo\n', b: '# kept\nREPO=example/project-b\n'}};
// The step a call ran under the script that gives it a session of its own (bash -c '<script>' detached <step...>).
const step = call => call.replace(/ bash -c .*setsid .* detached /, ' <session> ');

test('update, as an ordinary user, runs a fresh clone\'s provision with the machine file\'s settings and provision-project for each project as root, then the doctor for each', t => {
  const s = setup(t, twoProjects);
  const before = [s.config('a'), s.config('b')];
  const result = s.run('update');
  assert.equal(result.status, 0, result.stderr);
  const calls = s.calls();
  const clone = `${s.tmp}/tmp\\.\\w+/triphammer/bin`;
  const service = 'sudo -iu triphammer env XDG_RUNTIME_DIR=/run/user/1001';
  assert.equal(calls[0], 'sudo -v');
  // The configs are read, as the service user, before any step.
  assert.deepEqual(calls.slice(1, 4), [`${service} ls -1 ${s.home}/.config/triphammer`,
    `${service} sed -n s/^REPO=//p ${s.home}/.config/triphammer/a.conf`,
    `${service} sed -n s/^REPO=//p ${s.home}/.config/triphammer/b.conf`]);
  const rest = calls.slice(4);
  assert.match(step(rest[0]), new RegExp(`^sudo <session> bash ${clone}/provision --triphammer example/triphammer ${s.root}/triphammer --user triphammer --home ${s.home} --no-owner-steps$`));
  assert.equal(rest[1], `provision sudo=yes --triphammer example/triphammer ${s.root}/triphammer --user triphammer --home ${s.home} --no-owner-steps`);
  assert.match(step(rest[2]), new RegExp(`^sudo <session> bash ${clone}/provision-project example/project-a$`));
  assert.equal(rest[3], 'provision-project sudo=yes example/project-a');
  assert.equal(rest[5], 'provision-project sudo=yes example/project-b');
  assert.equal(rest[6], 'sudo systemctl --machine=triphammer@ --user show --property=NeedDaemonReload -- triphammer-status.service '
    + 'ticket-runner@a.service ticket-runner@a.timer merge-when-ready@a.service merge-when-ready@a.timer demo-gallery@a.service '
    + 'ticket-runner@b.service ticket-runner@b.timer merge-when-ready@b.service merge-when-ready@b.timer demo-gallery@b.service');
  assert.deepEqual(calls.filter(call => call.startsWith('ticket-runner')), [
    'ticket-runner project=a runtime=/run/user/1001 --doctor', 'ticket-runner project=b runtime=/run/user/1001 --doctor']);
  // It ends with what is left for the owner: provision's report, from the clone, as root.
  assert.match(step(calls.at(-2)), new RegExp(`^sudo <session> bash ${clone}/provision --owner-steps$`));
  assert.equal(calls.at(-1), 'provision sudo=yes --owner-steps');
  assert.ok(result.stdout.endsWith("The doctor's check of b:\nthe owner's steps\n"), result.stdout);
  assert.deepEqual(calls.filter(call => /systemctl .* (daemon-reload|enable|start|stop|restart)\b/.test(call)), [],
    'update reloaded or touched a unit');
  assert.match(result.stdout, /^Nothing to change: the machine and every project are as asked\.$/m);
  assert.deepEqual([s.config('a'), s.config('b')], before);
  assert.deepEqual(s.cwds(), ['/', '/', '/', '/']);
  assert.deepEqual(readdir(s.tmp), [], 'the clone was left behind');
  assert.deepEqual(s.sessions(), ['provision leader /dev/null', 'provision-project leader /dev/null',
    'provision-project leader /dev/null', 'ticket-runner leader /dev/null', 'ticket-runner leader /dev/null',
    'provision leader /dev/null']);
});

test('update reloads the service user\'s units only when systemd says a unit file changed, or cannot say', t => {
  for (const [what, marks, reload] of [['nothing stale', [], false], ['a stale unit', ['stale-units'], true],
    ['a failed query', ['show-fails'], true]]) {
    const s = setup(t, twoProjects);
    for (const name of marks) s.mark(name);
    const result = s.run('update');
    assert.equal(result.status, 0, `${what}: ${result.stderr}`);
    const reloads = s.calls().filter(call => call.includes('daemon-reload'));
    assert.deepEqual(reloads, reload ? ['sudo systemctl --machine=triphammer@ --user daemon-reload',
      'systemctl runtime= --machine=triphammer@ --user daemon-reload'] : [], what);
    assert.equal(/^\+ reload triphammer's systemd units$/m.test(result.stdout), reload, what);
    assert.equal(/^The changes above were made\.$/m.test(result.stdout), reload, what);
  }
});

test('update as root runs every step without sudo, and a change in any step is reported', t => {
  const s = setup(t, {...twoProjects, uid: '0', login: 'root'});
  s.mark('provision-project-changes');
  const result = s.run('update');
  assert.equal(result.status, 0, result.stderr);
  const calls = s.calls();
  assert.ok(!calls.some(call => call.startsWith('sudo -v') || call.startsWith('sudo <') || / sudo=yes /.test(call)));
  assert.ok(calls.includes(`provision sudo=no --triphammer example/triphammer ${s.root}/triphammer --user triphammer --home ${s.home} --no-owner-steps`));
  assert.equal(calls.at(-1), 'provision sudo=no --owner-steps');
  assert.ok(calls.some(call => call.startsWith('systemctl runtime= --machine=triphammer@ --user show ')));
  assert.match(result.stdout, /^The changes above were made\.$/m);
  assert.doesNotMatch(result.stdout, /sudo asks/);
});

test('update --dry-run passes --dry-run to provision and every provision-project, prints the reload, and reloads nothing and runs no doctor', t => {
  const s = setup(t, twoProjects);
  s.mark('stale-units');
  const before = [s.config('a'), s.config('b')];
  const result = s.run('update', '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  const calls = s.calls();
  assert.ok(calls.includes(`provision sudo=yes --triphammer example/triphammer ${s.root}/triphammer --user triphammer --home ${s.home} --no-owner-steps --dry-run`));
  assert.deepEqual(calls.filter(call => call.startsWith('provision-project')),
    ['provision-project sudo=yes example/project-a --dry-run', 'provision-project sudo=yes example/project-b --dry-run']);
  assert.ok(!calls.some(call => call.includes('daemon-reload')));
  assert.ok(!calls.some(call => call.startsWith('ticket-runner')));
  assert.match(result.stdout, /^would: reload triphammer's systemd units$/m);
  assert.match(result.stdout, /^The changes above would be made; nothing was changed\.$/m);
  // The report only reads, so a dry run ends with it too.
  assert.equal(calls.at(-1), 'provision sudo=yes --owner-steps');
  assert.ok(result.stdout.endsWith("nothing was changed.\nthe owner's steps\n"), result.stdout);
  assert.deepEqual([s.config('a'), s.config('b')], before);
  assert.deepEqual(readdir(s.tmp), []);
});

test('a provision that fails stops update; a provision-project that fails does not stop the other projects', t => {
  const stops = setup(t, twoProjects);
  stops.fail('machine', 3);
  const stopped = stops.run('update');
  assert.equal(stopped.status, 3, stopped.stderr);
  assert.ok(!stops.calls().some(call => call.startsWith('provision-project') || call.startsWith('ticket-runner')));
  assert.deepEqual(readdir(stops.tmp), []);

  const s = setup(t, twoProjects);
  mkdirSync(join(s.root, 'fails-example'));
  s.mark('fails-example/project-a');
  const result = s.run('update');
  assert.equal(result.status, 5, result.stderr);
  assert.deepEqual(s.calls().filter(call => call.startsWith('provision-project')),
    ['provision-project sudo=yes example/project-a', 'provision-project sudo=yes example/project-b']);
  assert.match(result.stderr, /provision-project example\/project-a failed \(exit 5\)/);
  assert.match(result.stderr, /not every step of the update succeeded/);
  assert.equal(s.calls().filter(call => call.startsWith('ticket-runner')).length, 2, 'the doctors did not run');
});

test('a doctor that finds a problem makes update exit 1, and a config without one REPO line stops it before any step', t => {
  const s = setup(t, twoProjects);
  s.fail('runner', 1);
  const result = s.run('update');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(s.calls().filter(call => call.startsWith('ticket-runner')).length, 2);

  for (const text of ['MODULES=demo\n', 'REPO=example/x\nREPO=example/y\n', 'REPO=$(touch /tmp/x)\n']) {
    const bad = setup(t, {projects: {a: 'REPO=example/project-a\n', b: text}});
    const refused = bad.run('update');
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /b\.conf names no repository as one REPO=<owner>\/<name> line/);
    assert.ok(!bad.calls().some(call => /^provision/.test(call)), text);
  }
});

test('a report that fails makes update exit 1 after every other step', t => {
  const s = setup(t, twoProjects);
  s.mark('owner-steps-fails');
  const result = s.run('update');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(s.calls().filter(call => call.startsWith('ticket-runner')).length, 2);
  assert.match(result.stderr, /^triphammer: provision could not list what is left for the owner \(exit 4\)$/m);
});

test('update refuses a machine file without Triphammer\'s checkout', t => {
  const s = setup(t);
  writeFileSync(join(s.root, 'sys/etc/triphammer.conf'), `TRIPHAMMER_REPO=example/triphammer\nTRIPHAMMER_USER=triphammer\nTRIPHAMMER_HOME=${s.home}\n`);
  const result = s.run('update');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /names no TRIPHAMMER_CHECKOUT/);
  assert.deepEqual(s.calls(), []);
});

for (const [signal, group, args, slow, as] of [
  ['SIGINT', false, ['add', 'example/example-project'], 'provision', {}],
  ['SIGTERM', false, ['add', 'example/example-project'], 'provision', {}],
  ['SIGINT', true, ['add', 'example/example-project'], 'provision', {}],
  ['SIGINT', false, ['plan'], 'runner', {}],
  ['SIGINT', true, ['plan'], 'runner', {}],
  ['SIGTERM', false, ['doctor'], 'runner', {login: 'triphammer', uid: '1001'}],
  ['SIGINT', true, ['update'], 'machine', {}],
  ['SIGTERM', false, ['update'], 'provision', {}],
]) {
  test(`${signal} to ${args[0]}${group ? "'s process group" : ''}${as.login ? ' as the service user' : ''} stops its step and the child the step started, and it ends by that signal`, async t => {
    const s = setup(t, as);
    s.slow(slow);
    const result = await s.interrupted(signal, group, ...args);
    assert.equal(result.signal, signal, `exited ${result.status}`);
    assert.ok(result.after < 1500, `${result.after} ms after the signal`);
    assert.deepEqual(result.steps, ['started']);
    if (args[0] !== 'plan' && args[0] !== 'doctor') {
      assert.ok(!s.calls().some(call => call.startsWith('ticket-runner')), `${args[0]} went on to the doctor`);
    }
    assert.deepEqual(readdir(s.tmp), []);
  });
}
