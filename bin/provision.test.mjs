import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {git, here, lines, run} from './fixture.mjs';
import {changingCalls, codename, machine, readdir, scripts, triphammerFiles, units} from './provision-fixture.mjs';

const tri = ['--triphammer', 'example/triphammer', '/CHECKOUT'];
// The arguments with /CHECKOUT made a path in the machine's temporary directory, and `--home` its user's home.
const at = (m, args) => [...args.map(arg => arg.replace(/^\/CHECKOUT/, join(m.root, 'triphammer'))), '--home', m.home];

for (const [what, args, message] of [
  ['no argument', [], /--triphammer is missing/],
  ['an unknown flag', [...tri, '--frobnicate'], /unknown argument --frobnicate/],
  ['a --triphammer without its checkout', ['--triphammer', 'example/x'], /--triphammer needs a repository and a checkout/],
  ['--triphammer twice', [...tri, '--triphammer', 'example/x', '/x'], /--triphammer is given twice/],
  ['a repository that is not owner/name', ['--triphammer', 'nope', '/x'], /--triphammer takes a repository as owner\/name, not nope/],
  ['a relative checkout', ['--triphammer', 'example/y', 'y'], /the checkout must be an absolute path/],
  ['a checkout with ..', ['--triphammer', 'example/y', '/srv/../y'], /without \. or \.\. parts/],
  ['a project argument', [...tri, '--project', 'example/y', '/y'], /--project belongs to triphammer add/],
  ['a malformed --user', [...tri, '--user', 'Bad User'], /--user must be a user name/],
  ['a relative --home', [...tri, '--home', 'home'], /--home must be an absolute path/],
  ['--owner-steps with another argument', ['--owner-steps', '--dry-run'], /--owner-steps takes no other argument/],
  ['--owner-steps after --triphammer', [...tri, '--owner-steps'], /--owner-steps takes no other argument/],
]) {
  test(`${what} stops provision with exit 2 and the usage before anything runs`, t => {
    const m = machine(t, {});
    const result = m.provision(...args.map(arg => arg.replace(/^\/CHECKOUT/, join(m.root, 'triphammer'))));
    assert.equal(result.status, 2, result.output);
    assert.match(result.stderr, message);
    assert.match(result.stderr, /^usage: provision --triphammer/m);
    assert.deepEqual(result.calls, []);
  });
}

test('on a fresh machine it installs everything but a project, and a second run changes nothing', t => {
  const m = machine(t, {'example/triphammer': triphammerFiles});
  const checkout = join(m.root, 'triphammer');
  writeFileSync(join(m.state, 'claude/logged-out'), '');
  const first = m.provision(...at(m, tri));
  assert.equal(first.status, 0, first.output);

  const {packages, users, linger, loaded, enabled, acls} = m.machine();
  for (const name of ['git', 'jq', 'python3', 'shellcheck', 'curl', 'bubblewrap', 'apparmor', 'docker-ce', 'docker-compose-plugin', 'gh',
    'docker-ce-rootless-extras', 'uidmap', 'slirp4netns', 'dbus-user-session', 'acl']) {
    assert.ok(packages.includes(name), name);
  }
  for (const name of ['codex', 'ffmpeg', 'docker.io', 'rootlesskit']) assert.ok(!packages.includes(name), name);
  // The sessions' write limit is bwrap, with its user namespaces, whatever modules the projects turn on.
  assert.match(readFileSync(join(m.sys, 'etc/apparmor.d/bwrap'), 'utf8'), /^profile bwrap \/usr\/bin\/bwrap flags=\(unconfined\) \{\n {2}userns,$/m);
  assert.deepEqual(loaded, ['bwrap']);
  assert.match(first.stdout, /^Docker Engine: from Docker's repository$/m);
  assert.match(first.stdout, /^GitHub CLI: from the GitHub CLI's repository$/m);
  assert.match(readFileSync(join(m.sys, 'etc/apt/sources.list.d/docker.sources'), 'utf8'), new RegExp(`^Suites: ${codename}$`, 'm'));
  assert.deepEqual(users.triphammer, {home: m.home, groups: ['triphammer']});
  // No rootless Docker daemon: provision-project sets one up for each project that declares Docker.
  assert.deepEqual(Object.keys(users), ['triphammer']);
  assert.deepEqual(linger, ['triphammer']);
  assert.deepEqual(enabled, []);
  assert.deepEqual(acls, {});
  for (const kind of ['uid', 'gid']) assert.ok(!existsSync(join(m.sys, `etc/sub${kind}`)), kind);
  assert.ok(!existsSync(join(m.sys, 'var/lib')), 'provision made a socket directory');

  assert.equal(git(checkout, 'remote', 'get-url', 'origin'), `file://${m.root}/origins/example/triphammer.git`);
  for (const name of scripts) assert.equal(readlinkSync(join(m.home, '.local/bin', name)), join(checkout, 'bin', name));
  assert.equal(readlinkSync(join(m.home, '.local/bin/triphammer-status')), join(checkout, 'status/server.mjs'));
  for (const name of units) assert.equal(readlinkSync(join(m.home, '.config/systemd/user', name)), join(checkout, 'systemd', name));
  assert.equal(readlinkSync(join(m.home, '.config/systemd/user/triphammer-status.service')), join(checkout, 'systemd/triphammer-status.service'));
  assert.ok(m.calls().some(([command, ...args]) => command === 'systemctl' && args.join(' ') === '--machine=triphammer@ --user daemon-reload'));
  assert.ok(!m.calls().some(([command, ...args]) => command === 'systemctl' && args.includes('enable') && args.includes('--machine=triphammer@')),
    'provision enabled a unit of the service user\'s');

  assert.equal(statSync(join(m.home, '.config/github-app')).mode & 0o777, 0o700);
  assert.deepEqual(readdir(join(m.home, '.config/github-app')), []);
  assert.equal(run('git', ['config', '--file', join(m.home, '.gitconfig'), '--get-all', 'credential.https://github.com.helper']),
    '\n!github-app-token git-credential\n');
  const gitConfig = key => run('git', ['config', '--file', join(m.home, '.gitconfig'), '--get', key]).trim();
  assert.equal(gitConfig('credential.https://github.com.useHttpPath'), 'true');
  assert.ok(!existsSync(join(m.home, '.config/triphammer')), 'provision wrote a project config');

  assert.equal(run(join(m.sys, 'usr/local/bin/node'), ['--version']), 'v24.19.0\n');
  assert.deepEqual(lines(join(m.state, 'claude-install-calls')), ['installed']);
  assert.deepEqual(JSON.parse(readFileSync(join(m.state, 'claude/plugins.json'), 'utf8')),
    {marketplaces: [{name: 'triphammer'}, {name: 'humanizer'}],
      plugins: [{id: 'triphammer@triphammer', scope: 'user'}, {id: 'humanizer@humanizer', scope: 'user'}]});
  // Run from a terminal, a claude outside the terminal's foreground group that touches it is stopped, so each one runs
  // in a session of its own with nothing on stdin.
  const pluginCalls = lines(join(m.state, 'claude/plugin-calls')).map(line => JSON.parse(line));
  const pluginChanges = calls => calls.filter(call => call.args.includes('add') || call.args[0] === 'install')
    .map(call => call.args.join(' '));
  assert.deepEqual(pluginChanges(pluginCalls), [`marketplace add ${checkout}`, 'install triphammer@triphammer --scope user',
    'marketplace add blader/humanizer', 'install humanizer@humanizer --scope user']);
  for (const call of pluginCalls) {
    assert.deepEqual({sessionLeader: call.sessionLeader, stdin: call.stdin}, {sessionLeader: true, stdin: '/dev/null'},
      `claude plugin ${call.args.join(' ')} ran attached`);
  }
  assert.ok(!existsSync(join(m.state, 'dotnet-install-calls')), 'provision installed a project toolchain');

  const machineFile = join(m.sys, 'etc/triphammer.conf');
  assert.equal(readFileSync(machineFile, 'utf8').split('\n').slice(1).join('\n'),
    `TRIPHAMMER_REPO=example/triphammer\nTRIPHAMMER_CHECKOUT=${checkout}\nTRIPHAMMER_USER=triphammer\nTRIPHAMMER_HOME=${m.home}\n`);
  assert.equal(statSync(machineFile).mode & 0o777, 0o644);
  const command = join(m.sys, 'usr/local/bin/triphammer');
  assert.equal(readFileSync(command, 'utf8'), readFileSync(join(here, 'triphammer'), 'utf8'));
  assert.equal(statSync(command).mode & 0o777, 0o755);
  assert.equal(statSync(command).isSymbolicLink(), false);

  assert.match(first.stdout, /change\(s\) made\./);
  // A fresh machine has every step left.
  const app = join(m.home, '.config/github-app');
  assert.ok(first.stdout.endsWith(`\nNext, as the owner (provision never reads or writes a credential):
  1. The App's files in ${app}:
     - app-id is missing: put the App's numeric id in ${app}/app-id, owned by triphammer, mode 600
     - owner is missing: put the login of the account the App is installed on in ${app}/owner, owned by triphammer, mode 600
     - agents.pem is missing: put the App's private key in ${app}/agents.pem, owned by triphammer, mode 600
  2. Log Claude Code in: sudo -iu triphammer claude auth login (or claude setup-token; bin/README.md).
  3. Add a project: triphammer add <owner>/<repo>
  4. Optionally the status page: sudo systemctl --machine=triphammer@ --user enable --now triphammer-status.service
`), first.stdout);

  const changed = changingCalls(first.calls).map(call => call.join(' '));
  for (const pattern of [/^runuser .* git .*clone /, /^runuser .* sh -c /, /^apt-get install /, /^useradd /, /^systemctl .* link /]) {
    assert.ok(changed.some(call => pattern.test(call)), `the first run's changes include ${pattern}`);
  }

  const second = m.provision(...at(m, tri));
  assert.equal(second.status, 0, second.output);
  assert.match(second.stdout, /^Nothing to change: the machine is as asked\.$/m);
  assert.doesNotMatch(second.stdout, /^\+ /m);
  assert.deepEqual(changingCalls(second.calls), []);
  const secondPluginCalls = lines(join(m.state, 'claude/plugin-calls')).map(line => JSON.parse(line)).slice(pluginCalls.length);
  assert.ok(secondPluginCalls.length >= 4, `expected the second run's list calls, got ${secondPluginCalls.length}`);
  assert.deepEqual(pluginChanges(secondPluginCalls), []);

  // A triphammer command that is not this script's copy is put back.
  writeFileSync(command, '#!/bin/sh\necho changed\n');
  const third = m.provision(...at(m, tri));
  assert.equal(third.status, 0, third.output);
  assert.equal(readFileSync(command, 'utf8'), readFileSync(join(here, 'triphammer'), 'utf8'));
});

test('the machine file keeps the lines provision does not write', t => {
  const m = machine(t, {'example/triphammer': triphammerFiles});
  assert.equal(m.provision(...at(m, tri)).status, 0);
  // A project's own daemon's keys that provision-project wrote.
  const machineFile = join(m.sys, 'etc/triphammer.conf');
  const kept = 'TRIPHAMMER_DOCKER_USER_EXAMPLE=triphammer-docker-example\nTRIPHAMMER_DOCKER_SOCKET_EXAMPLE=/var/lib/triphammer-docker-example/docker.sock\n';
  const before = readFileSync(machineFile, 'utf8');
  writeFileSync(machineFile, `${before.replace(/^TRIPHAMMER_HOME=.*\n/m, 'TRIPHAMMER_HOME=/elsewhere\n')}${kept}`);

  const result = m.provision(...at(m, tri));
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(changingCalls(result.calls), []);
  assert.match(result.stdout, /^\+ write .*\/etc\/triphammer\.conf$/m);
  assert.equal(readFileSync(machineFile, 'utf8'), `${before}${kept}`);
  assert.match(m.provision(...at(m, tri)).stdout, /^Nothing to change/m);
});

test('a private repository: the first run creates the App\'s directory and stops at the clone, and once the owner places the App\'s files the next run clones with its token', t => {
  const m = machine(t, {'example/triphammer': triphammerFiles}, {privateOrigins: true});
  const checkout = join(m.root, 'triphammer');
  const app = join(m.home, '.config/github-app');
  const first = m.provision(...at(m, tri));
  assert.equal(first.status, 1, first.output);
  assert.match(first.stderr, new RegExp(`could not clone example/triphammer into ${checkout}; a private repository needs the App's files in ${app} first`));
  assert.equal(statSync(app).mode & 0o777, 0o700);
  assert.deepEqual(readdir(app), []);
  assert.ok(!existsSync(join(checkout, '.git')), 'the clone happened without credentials');
  assert.deepEqual(readdir(join(m.sys, 'tmp')), [], 'the copy of github-app-token was left behind');

  m.placeApp();
  const second = m.provision(...at(m, tri));
  assert.equal(second.status, 0, second.output);
  assert.equal(git(checkout, 'remote', 'get-url', 'origin'), `file://${m.root}/origins/example/triphammer.git`);
  const clones = second.calls.filter(([command, ...args]) => command === 'git' && args.includes('clone'));
  assert.equal(clones.length, 1);
  assert.match(clones[0].join(' '), new RegExp(`-c credential\\.https://github\\.com\\.helper= -c credential\\.https://github\\.com\\.helper=!${m.sys}/tmp/github-app-token\\.\\w+/github-app-token git-credential clone `));
  assert.deepEqual(readdir(join(m.sys, 'tmp')), [], 'the copy of github-app-token was left behind');
  assert.ok(!second.output.includes('ghs_fake'), 'the token reached the output');
  assert.match(m.provision(...at(m, tri)).stdout, /^Nothing to change/m);
});

test('without the vendors\' repositories for the release, Docker and gh come from Ubuntu\'s archive', t => {
  const m = machine(t, {'example/triphammer': triphammerFiles}, {dockerRepo: false, ghRepo: false});
  const result = m.provision(...at(m, tri));
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /^Docker Engine: from Ubuntu's archive \(docker\.io, docker-compose-v2\), as Docker's repository does not serve resolute$/m);
  assert.match(result.stdout, /^GitHub CLI: from Ubuntu's archive \(gh\)/m);
  const {packages} = m.machine();
  for (const name of ['docker.io', 'docker-compose-v2', 'gh', 'rootlesskit', 'uidmap', 'slirp4netns', 'dbus-user-session', 'acl']) {
    assert.ok(packages.includes(name), name);
  }
  assert.ok(!packages.includes('docker-ce'));
  assert.ok(!packages.includes('docker-ce-rootless-extras'));
  assert.ok(!existsSync(join(m.sys, 'etc/apt/sources.list.d/github-cli.sources')), 'the failed vendor repository was left behind');
  assert.match(m.provision(...at(m, tri)).stdout, /^Nothing to change/m);
});

test('a service user in the docker group leaves it, and provision says its running processes keep it', t => {
  const m = machine(t, {'example/triphammer': triphammerFiles});
  assert.equal(m.provision(...at(m, tri)).status, 0);
  const state = m.machine();
  state.users.triphammer.groups.push('docker');
  writeFileSync(join(m.state, 'machine.json'), JSON.stringify(state));

  const result = m.provision(...at(m, tri));
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /^\+ remove triphammer from the docker group$/m);
  assert.match(result.stdout, /^Docker: triphammer's running processes keep the docker group until its user manager restarts \(sudo systemctl restart user@\d+\.service/m);
  assert.deepEqual(changingCalls(result.calls).map(call => call.join(' ')), ['gpasswd -d triphammer docker']);
  assert.deepEqual(m.machine().users.triphammer.groups, ['triphammer']);
  assert.match(m.provision(...at(m, tri)).stdout, /^Nothing to change/m);
});

test('--dry-run on a fresh machine lists the changes and makes none', t => {
  const m = machine(t, {'example/triphammer': triphammerFiles});
  const result = m.provision(...at(m, tri), '--dry-run');
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /^would: install ca-certificates curl git jq python3 openssl xz-utils shellcheck bubblewrap apparmor$/m);
  assert.match(result.stdout, /^would: load the AppArmor profile .*\/etc\/apparmor\.d\/bwrap$/m);
  assert.match(result.stdout, /^would: create the user triphammer with the home /m);
  assert.doesNotMatch(result.stdout, /triphammer-docker|docker\.service/);
  assert.match(result.stdout, /^would: clone example\/triphammer into /m);
  assert.match(result.stdout, /^would: write .*\/etc\/triphammer\.conf$/m);
  assert.match(result.stdout, /^would: add the plugin marketplace humanizer from blader\/humanizer for triphammer$/m);
  assert.match(result.stdout, /^would: install the plugin humanizer@humanizer at user scope for triphammer$/m);
  assert.match(result.stdout, /^Node: the version comes from Triphammer's checkout, which is not cloned yet/m);
  assert.match(result.stdout, /change\(s\) to make; nothing was changed\./);
  assert.doesNotMatch(result.stdout, /^\+ /m);
  assert.deepEqual(changingCalls(result.calls), []);
  assert.ok(!existsSync(m.home) && !existsSync(join(m.root, 'triphammer')) && !existsSync(join(m.sys, 'etc/apt'))
    && !existsSync(join(m.sys, 'etc/triphammer.conf')));
  // The report only reads, so a dry run ends with it too: on a machine without the user, every step is left.
  assert.deepEqual(result.stdout.match(/^ {2}\d\. .*/gm).map(line => line.slice(0, 20)),
    ['  1. The App\'s files', '  2. Log Claude Code', '  3. Add a project: ', '  4. Optionally the ']);
});

const setState = (m, state) => writeFileSync(join(m.state, 'machine.json'), JSON.stringify(state));

// The owner's steps on a machine provision has set up: the App's files placed (with sentinels for the values no
// output may show), Claude Code logged in, one project whose timers and the status page are enabled; `undo` takes one
// of them back before `provision --owner-steps` runs.
function ownerSteps(t, undo = () => {}) {
  const m = machine(t, {'example/triphammer': triphammerFiles});
  const provisioned = m.provision(...at(m, tri));
  assert.equal(provisioned.status, 0, provisioned.output);
  m.placeApp();
  const app = join(m.home, '.config/github-app');
  writeFileSync(join(app, 'app-id'), '918273645\n');
  writeFileSync(join(app, 'owner'), 'sentinel-owner-login\n');
  mkdirSync(join(m.home, '.config/triphammer'), {recursive: true});
  writeFileSync(join(m.home, '.config/triphammer/project-a.conf'), 'REPO=example/project-a\n');
  const after = m.machine();
  const state = {...after, enabled: [...after.enabled, ...['ticket-runner@project-a.timer', 'merge-when-ready@project-a.timer',
    'triphammer-status.service'].map(unit => `triphammer:${unit}`)]};
  setState(m, state);
  undo(m, app, state);
  const authCalls = lines(join(m.state, 'claude/auth-calls')).length;
  const result = m.provision('--owner-steps');
  assert.equal(result.status, 0, result.output);
  assert.equal(result.stderr, '');
  for (const secret of ['918273645', 'sentinel-owner-login', 'PRIVATE KEY', 'fake-account@example.invalid', 'loggedIn']) {
    assert.ok(!result.output.includes(secret), `the report shows ${secret}`);
  }
  if (existsSync(join(app, 'agents.pem'))) {
    for (const line of readFileSync(join(app, 'agents.pem'), 'utf8').split('\n').filter(line => line.length > 20)) {
      assert.ok(!result.output.includes(line), 'the report shows the App\'s key');
    }
  }
  // claude auth status ran as the user in a session of its own with nothing on stdin.
  const auth = lines(join(m.state, 'claude/auth-calls')).slice(authCalls).map(line => JSON.parse(line));
  assert.deepEqual(auth, [{sessionLeader: true, stdin: '/dev/null'}]);
  assert.deepEqual(changingCalls(result.calls), []);
  return {m, app, steps: result.stdout.split('\n').filter(line => /^ {2}\d\. | {5}- /.test(line)), stdout: result.stdout};
}

test('on a machine with every step done, the report is one line saying it is ready, and provision ends with it', t => {
  const {m, stdout} = ownerSteps(t);
  assert.equal(stdout, '\nNothing left for the owner: the machine is ready.\n');
  const again = m.provision(...at(m, tri));
  assert.equal(again.status, 0, again.output);
  assert.ok(again.stdout.endsWith('\nNothing to change: the machine is as asked.\n\nNothing left for the owner: the machine is ready.\n'),
    again.stdout);
  // --no-owner-steps leaves the report out.
  const without = m.provision(...at(m, tri), '--no-owner-steps');
  assert.equal(without.status, 0, without.output);
  assert.ok(without.stdout.endsWith('\nNothing to change: the machine is as asked.\n'), without.stdout);
});

for (const [what, undo, expected] of [
  ['a wrong mode on agents.pem', (m, app) => chmodSync(join(app, 'agents.pem'), 0o644),
    app => [`  1. The App's files in ${app}:`, `     - agents.pem has mode 644, not 600: chmod 600 ${app}/agents.pem`]],
  ['a missing app-id', (m, app) => rmSync(join(app, 'app-id')),
    app => [`  1. The App's files in ${app}:`, `     - app-id is missing: put the App's numeric id in ${app}/app-id, owned by triphammer, mode 600`]],
  ['an app-id that is a directory', (m, app) => { rmSync(join(app, 'app-id')); mkdirSync(join(app, 'app-id')); },
    app => [`  1. The App's files in ${app}:`, `     - app-id is not a regular file: replace ${app}/app-id with the App's numeric id, owned by triphammer, mode 600`]],
  ['files someone else owns', (m, app, state) => setState(m, {...state, users: {...state.users, triphammer: {...state.users.triphammer, uid: 4242}}}),
    app => [`  1. The App's files in ${app}:`, ...['app-id', 'owner', 'agents.pem'].map(name =>
      `     - ${name} is not owned by triphammer: chown triphammer ${app}/${name}`)]],
  ['a key the App rejects', (m, app, state) => {
    const {'https://api.github.com/app': _, ...downloads} = state.downloads;
    setState(m, {...state, downloads});
  }, app => [`  1. The App's files in ${app}:`, '     - GitHub did not accept the App\'s key, or could not be reached: app-id or agents.pem is not the App\'s; replace them with the App\'s, owned by triphammer, mode 600']],
  ['Claude Code logged out', m => writeFileSync(join(m.state, 'claude/logged-out'), ''),
    () => ['  1. Log Claude Code in: sudo -iu triphammer claude auth login (or claude setup-token; bin/README.md).']],
  ['no project', m => rmSync(join(m.home, '.config/triphammer/project-a.conf')),
    () => ['  1. Add a project: triphammer add <owner>/<repo>']],
  ['a project whose timers are off', (m, app, state) => {
    writeFileSync(join(m.home, '.config/triphammer/project-b.conf'), 'REPO=example/project-b\n');
    setState(m, {...state, enabled: [...state.enabled, 'triphammer:ticket-runner@project-b.timer']});
  }, () => ['  1. Start the projects whose timers are off (triphammer add <owner>/<repo> adds another):',
    '     - project-a: its timers are on', '     - project-b: triphammer start project-b']],
  ['the status page not enabled', (m, app, state) => setState(m, {...state, enabled: state.enabled.slice(0, -1)}),
    () => ['  1. Optionally the status page: sudo systemctl --machine=triphammer@ --user enable --now triphammer-status.service']],
]) {
  test(`with ${what}, the report lists that step alone, with its fix`, t => {
    const {app, steps, stdout} = ownerSteps(t, undo);
    assert.match(stdout, /^Next, as the owner \(provision never reads or writes a credential\):$/m);
    assert.deepEqual(steps, expected(app));
  });
}

test('a checkout path that holds something else stops provision with exit 1 before anything changes', t => {
  const m = machine(t, {'example/triphammer': triphammerFiles});
  mkdirSync(join(m.root, 'triphammer'));
  writeFileSync(join(m.root, 'triphammer/stray'), 'x\n');
  const result = m.provision(...at(m, tri));
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /triphammer exists and is not triphammer's clone of example\/triphammer; move it away/);
  assert.deepEqual(changingCalls(result.calls), []);
});

test('a Triphammer checkout that pins no Node version stops provision with exit 1', t => {
  const {'.node-version': _, ...files} = triphammerFiles;
  const m = machine(t, {'example/triphammer': files});
  const result = m.provision(...at(m, tri));
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /pins no Node version in \.node-version/);
});
