import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fakeAnswers, fakeCommand, git, here, lines, projectJson, realCommand, run, runnerSetup} from './fixture.mjs';

// What a credential file holds in these tests; it must never reach the doctor's output.
const sentinel = 'SENTINEL-CREDENTIAL-CONTENT-4c1f';
const qwenUrl = 'http://model.example.invalid:8080';
const dotNetDropIn = '[Service]\nEnvironment=PATH=%h/.local/bin:%h/.dotnet:%h/.dotnet/tools:/usr/local/bin:/usr/bin:/bin\n'
  + 'Environment=DOTNET_ROOT=%h/.dotnet\n';
const repoLabels = ['agent-working', 'bug', 'Cleanup', 'Hold', 'Light', 'needs-owner', 'next', 'stop-agents', 'upkeep'];
const rootful = 'unix:///var/run/docker.sock';
const globalJson = rollForward => JSON.stringify({sdk: {version: '10.0.400', rollForward, allowPrerelease: false}});

// A machine whose checkout has this branch's doctor and ticket-runner@.service, a global.json pinning 10.0.400
// (`rollForward`) and a package.json asking for Node >=24.19.0 <25 and pinning Playwright 1.63.0, on a machine where
// everything the doctor checks is right: HOME and XDG_CONFIG_HOME (HOME's .config) in the temporary directory, with
// the drop-in that
// bin/README.md gives for a .NET SDK (`dotNetDropIn`), so the units' PATH starts with its ~/.local/bin (the fakes'
// `bin`) and ~/.dotnet (a fake dotnet), fake node, shellcheck, systemctl (every unit enabled), bwrap (creates user namespaces), claude (logged
// in, with the Triphammer and humanizer plugins at user scope), codex, curl (QWEN_BASE_URL answers), gh (acting as
// the App) and docker (Compose v2; the rootless daemon the machine file names answers and the rootful one does not)
// in `bin`, the App's files and a Qwen key file holding `sentinel` with mode 600, a git config giving a commit identity, a Playwright Chromium
// that starts headless, and a repository that has every label Triphammer uses (`repoLabels`, as gh label list prints
// them). Its project declares "docker": true, unless `project` gives another project file. `doctor` runs
// `ticket-runner --doctor` and returns its status and output.
function doctorSetup(t, {config = {}, rollForward = 'latestPatch',
  project = `${JSON.stringify({...JSON.parse(projectJson), docker: true})}\n`} = {}) {
  const r = runnerSetup(t, {
    config,
    project,
    files: {
      'bin/doctor': readFileSync(join(here, 'doctor'), 'utf8'),
      'systemd/ticket-runner@.service': readFileSync(join(here, '../systemd/ticket-runner@.service'), 'utf8'),
      '.claude-plugin/marketplace.json': readFileSync(join(here, '../.claude-plugin/marketplace.json'), 'utf8'),
      'global.json': globalJson(rollForward),
      'package.json': JSON.stringify({engines: {node: '>=24.19.0 <25'}, devDependencies: {'@playwright/test': '1.63.0'}}),
    },
  });
  const bin = r.gh.bin;
  r.docker.refuse(rootful);
  // The home of the project's rootless daemon's user, as provision-project makes it, with getent and stat from the fake
  // machine (fake-machine.mjs), whose stat reports root as the owner of the paths `owners` gives 0.
  const machine = join(r.root, 'fake-machine');
  const dockerHome = join(r.root, 'example-docker-triphammer');
  const daemonUnits = join(dockerHome, '.config/systemd/user');
  const daemonUnit = join(daemonUnits, 'docker.service');
  const owners = {};
  for (const dir of ['', '.config', '.config/systemd', '.config/systemd/user', '.config/systemd/user/default.target.wants',
    '.local', '.local/share']) {
    mkdirSync(join(dockerHome, dir), {recursive: true});
    chmodSync(join(dockerHome, dir), 0o755);
    owners[join(dockerHome, dir)] = 0;
  }
  mkdirSync(join(dockerHome, '.local/share/docker'), {mode: 0o700});
  writeFileSync(daemonUnit, '[Service]\n');
  chmodSync(daemonUnit, 0o644);
  owners[daemonUnit] = 0;
  symlinkSync(daemonUnit, join(daemonUnits, 'default.target.wants/docker.service'));
  mkdirSync(machine);
  const machineState = state => writeFileSync(join(machine, 'machine.json'), JSON.stringify({stat: realCommand('stat'), ...state}));
  // The other project's daemon user (runnerSetup's machine file names it) has a home of the same shape.
  machineState({users: {'example-docker-triphammer': {home: dockerHome}, 'example-docker-other-project': {home: dockerHome}}, owners});
  for (const name of ['getent', 'stat']) fakeCommand(bin, name, join(machine, name), 'machine');
  // gh's --jq is built in, so the setting's answer is canned as it prints and needs no jq; tests that serve
  // repo.json instead run it through jq as gh would.
  r.gh.respond({'label list': {stdout: `${repoLabels.join('\n')}\n`}, 'api repos/': {stdout: 'true\n'}});
  const home = join(r.root, 'home');
  for (const dir of ['.dotnet', '.local']) mkdirSync(join(home, dir), {recursive: true});
  symlinkSync(bin, join(home, '.local/bin'));
  const userUnits = join(home, '.config/systemd/user');
  mkdirSync(join(userUnits, 'ticket-runner@.service.d'), {recursive: true});
  writeFileSync(join(userUnits, 'ticket-runner@.service.d/dotnet.conf'), dotNetDropIn);
  const answers = (name, routes) =>
    fakeAnswers(name === 'dotnet' ? join(home, '.dotnet') : bin, name, join(r.root, name), routes);
  answers('dotnet', {'--list-sdks': {stdout: '8.0.100 [/sdk]\n10.0.402 [/sdk]\n'}});
  answers('node', {'--version': {stdout: 'v24.22.1\n'}});
  answers('shellcheck', {'--version': {stdout: 'ShellCheck - shell script analysis tool\nversion: 0.10.0\n'}});
  answers('systemctl', {'--user is-enabled': {stdout: 'enabled\n'}});
  answers('bwrap', {'--version': {stdout: 'bubblewrap 0.11.0\n'}, '--unshare-user': {}});
  const sessions = join(r.root, 'sessions');
  mkdirSync(sessions);
  fakeCommand(bin, 'claude', sessions);
  writeFileSync(join(sessions, 'plugins.json'), JSON.stringify({marketplaces: [],
    plugins: [{id: 'triphammer@triphammer', scope: 'user'}, {id: 'humanizer@humanizer', scope: 'user'}]}));
  fakeCommand(bin, 'codex', sessions);
  const curl = join(r.root, 'curl');
  mkdirSync(curl);
  const curlRoutes = routes => writeFileSync(join(curl, 'routes.json'), JSON.stringify(routes));
  curlRoutes({[`GET ${qwenUrl}`]: {}});
  fakeCommand(bin, 'curl', curl);
  const app = join(r.root, 'github-app');
  mkdirSync(app);
  const qwenKey = join(r.root, 'qwen-key');
  for (const file of [join(app, 'app-id'), join(app, 'owner'), join(app, 'agents.pem'), qwenKey]) {
    writeFileSync(file, `${sentinel}\n`, {mode: 0o600});
  }
  const browsers = join(r.root, 'ms-playwright');
  // chromium(<revision>, <script>): a Playwright Chromium whose browser runs the script; by default it prints a blank page.
  const chromium = (revision, script = "echo '<html><head></head><body></body></html>'") => {
    mkdirSync(join(browsers, `chromium-${revision}/chrome-linux64`), {recursive: true});
    writeFileSync(join(browsers, `chromium-${revision}/chrome-linux64/chrome`), `#!/bin/sh\n${script}\n`, {mode: 0o755});
  };
  chromium(1243);
  // The commit identity the service user's git config gives; the doctor checks only that it is set.
  const gitConfig = join(r.root, 'gitconfig');
  writeFileSync(gitConfig, '[user]\n\tname = identity-name-7e2a\n\temail = identity-email-7e2a@example.invalid\n');
  const env = {...r.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GITHUB_APP_CONFIG_DIR: app, PLAYWRIGHT_BROWSERS_PATH: browsers, GIT_CONFIG_GLOBAL: gitConfig};
  // A command `name` whose `--version` fails, as a missing one would, and that otherwise runs `real`.
  const broken = (name, real) => writeFileSync(join(bin, name),
    `#!/bin/sh\n[ "$1" = --version ] && exit 127\n${real ? `exec '${real}' "$@"` : 'exit 127'}\n`, {mode: 0o755});
  return {
    ...r, bin, home, userUnits, app, qwenKey, browsers, chromium, answers, curlRoutes, broken, dockerHome, daemonUnits,
    daemonUnit, owners, machineState,
    doctor(extraEnv = {}, args = []) {
      const result = spawnSync(join(r.checkout, 'bin/ticket-runner'), ['--doctor', ...args],
        {env: {...env, ...extraEnv}, encoding: 'utf8'});
      const output = result.stdout + result.stderr;
      assert.doesNotMatch(output, new RegExp(sentinel), 'a credential file\'s contents reached the output');
      assert.doesNotMatch(output, /fake-account@example\.invalid/, 'an account name reached the output');
      assert.doesNotMatch(output, /identity-(name|email)-7e2a/, 'the commit identity reached the output');
      return {status: result.status, output, problems: result.stdout.split('\n').filter(line => line.includes('. Fix: '))};
    },
  };
}
const allModules = {MODULES: 'demo,qwen-audit,codex', QWEN_BASE_URL: qwenUrl, QWEN_MODEL: 'qwen', DEMO_URL: 'http://gallery.example.invalid/',
  DEMO_GALLERY_DIR: '/nonexistent/gallery'};

// Asserts that the doctor fails with exactly one problem, matching `pattern`.
function assertOneProblem(result, pattern) {
  assert.equal(result.status, 1, result.output);
  assert.equal(result.problems.length, 1, result.output);
  assert.match(result.problems[0], pattern);
  assert.match(result.output, /^1 problem\(s\) found$/m);
}

test('a healthy machine passes, and the doctor starts no tick', t => {
  const r = doctorSetup(t);
  const result = r.doctor();
  assert.equal(result.status, 0, result.output);
  assert.equal(result.output, 'all good\n');
  assert.equal(existsSync(join(r.root, 'state/ticket-runner')), false, 'the doctor created the runner state');
  assert.deepEqual(r.gh.calls(), [['--version'], ['api', 'installation/repositories', '--jq', '.total_count'],
    ['label', 'list', '-R', 'Example-Owner/example-project', '--limit', '1000', '--json', 'name', '--jq', '.[].name'],
    ['api', 'repos/Example-Owner/example-project', '--jq', '.delete_branch_on_merge | tojson']]);
  const units = lines(join(r.root, 'systemctl/calls')).map(line => JSON.parse(line).at(-1));
  assert.deepEqual(units, ['ticket-runner@triphammer.timer', 'merge-when-ready@triphammer.timer']);
});

test('a healthy machine with every module on passes, checking the modules\' tools, files, server and unit', t => {
  const r = doctorSetup(t, {config: {...allModules, QWEN_KEY_FILE: null}});
  writeConfig(r);
  const result = r.doctor();
  assert.equal(result.status, 0, result.output);
  assert.equal(lines(join(r.root, 'curl/calls')).length, 1);
  assert.deepEqual(lines(join(r.root, 'sessions/codex-calls')).map(line => JSON.parse(line)), [['--version'], ['login', 'status']]);
  assert.ok(lines(join(r.root, 'systemctl/calls')).some(line => line.includes('demo-gallery@triphammer.service')));
});

// The Triphammer config with every module on and Triphammer's Qwen key file (its path is only known once Triphammer exists).
function writeConfig(r) {
  writeFileSync(r.configFile, `${readFileSync(r.configFile, 'utf8')}QWEN_KEY_FILE=${r.qwenKey}\n`);
}

test('a Chromium that does not start headless is reported, the newest revision checked', t => {
  const r = doctorSetup(t);
  r.chromium(1250, 'echo "error while loading shared libraries: libnss3.so" >&2; exit 127');
  assertOneProblem(r.doctor(), /^Chromium does not start headless \(.*chromium-1250\/chrome-linux64\/chrome\)\. Fix: install its system libraries: .*, or run triphammer update /);
  r.chromium(1250);
  r.chromium(1243, 'exit 1');
  assert.equal(r.doctor().status, 0);
});

test('with or without the codex module, a bwrap that cannot create a user namespace, or none, is reported', t => {
  for (const config of [{}, {MODULES: 'codex'}]) {
    const r = doctorSetup(t, {config});
    assert.equal(r.doctor().status, 0);
    assert.deepEqual(lines(join(r.root, 'bwrap/calls')).map(line => JSON.parse(line)),
      [['--version'], ['--unshare-user', '--ro-bind', '/', '/', 'true']]);
    r.answers('bwrap', {'--version': {stdout: 'bubblewrap 0.11.0\n'}, '--unshare-user': {exit: 1, stderr: 'bwrap: setting up uid map: Permission denied\n'}});
    assertOneProblem(r.doctor(), /^bwrap cannot create a user namespace, so the sessions' write limit fails and no session starts\. Fix: install the AppArmor profile \/etc\/apparmor\.d\/bwrap .*as triphammer update does/);
    r.broken('bwrap');
    assertOneProblem(r.doctor(), /^bubblewrap \(bwrap\) is not installed or does not run on the units' PATH\. Fix: install bubblewrap \(apt-get install bubblewrap\) where the units' PATH finds it; the sessions' write limit needs it$/);
  }
});

test('a .NET SDK outside global.json\'s pin and rollForward is reported', t => {
  const r = doctorSetup(t);
  r.answers('dotnet', {'--list-sdks': {stdout: '10.0.300 [/sdk]\n10.0.500-preview.1 [/sdk]\n'}});
  assertOneProblem(r.doctor(), /^no \.NET SDK matches 10\.0\.400 \(rollForward latestPatch\).*Fix: run triphammer update, which installs it on a machine of its own; elsewhere install the \.NET SDK 10\.0\.400/);
  r.answers('dotnet', {});
  assertOneProblem(r.doctor(), /^no \.NET SDK matches 10\.0\.400/);
});

test('rollForward disable takes the pinned SDK only, and latestFeature a later feature band', t => {
  const exact = doctorSetup(t, {rollForward: 'disable'});
  assertOneProblem(exact.doctor(), /^no \.NET SDK matches 10\.0\.400 \(rollForward disable\)/);
  exact.answers('dotnet', {'--list-sdks': {stdout: '10.0.400 [/sdk]\n'}});
  assert.equal(exact.doctor().status, 0);
  const feature = doctorSetup(t, {rollForward: 'latestFeature'});
  feature.answers('dotnet', {'--list-sdks': {stdout: '10.0.500 [/sdk]\n'}});
  assert.equal(feature.doctor().status, 0);
});

test('a Node outside package.json\'s engines is reported', t => {
  const r = doctorSetup(t);
  r.answers('node', {'--version': {stdout: 'v25.0.0\n'}});
  assertOneProblem(r.doctor(), /^Node 25\.0\.0 is outside >=24\.19\.0 <25.*Fix: install a Node version within/);
  r.answers('node', {'--version': {stdout: 'v24.18.9\n'}});
  assertOneProblem(r.doctor(), /^Node 24\.18\.9 is outside/);
});

test('engines.node partial versions are ranges, as in semver', t => {
  const r = doctorSetup(t);
  // engines.node is `engines`, and node reports `version`.
  const check = (engines, version) => {
    writeFileSync(join(r.checkout, 'package.json'), JSON.stringify({engines: {node: engines}}));
    git(r.checkout, 'commit', '-qam', `engines ${engines}`, '--allow-empty');
    git(r.checkout, 'push', '-q', 'origin', 'main');
    r.answers('node', {'--version': {stdout: `v${version}\n`}});
    return r.doctor();
  };
  for (const [engines, version] of [['24', '24.22.1'], ['=24.22', '24.22.1'], ['<=24', '24.22.1'], ['<=24.22', '24.22.9'],
    ['>24', '25.0.0'], ['>24.21', '24.22.0'], ['<25', '24.99.0'], ['>=24', '24.0.0'], ['>23.9.9 <=24.0.0', '24.0.0']]) {
    assert.equal(check(engines, version).status, 0, `${version} is within ${engines}`);
  }
  for (const [engines, version] of [['24', '25.0.0'], ['24.22', '24.23.0'], ['<=24', '25.0.0'], ['>24', '24.0.0'],
    ['>24', '24.99.0'], ['>24.21', '24.21.9'], ['<24', '24.0.0'], ['>=24.1', '24.0.9']]) {
    assertOneProblem(check(engines, version), new RegExp(`^Node ${version.replaceAll('.', '\\.')} is outside ${engines}`));
  }
});

test('a rootless Docker daemon that does not answer the user, and Docker without Compose v2, are reported', t => {
  const r = doctorSetup(t);
  assert.equal(r.doctor().status, 0);
  const asked = r.docker.hosts().filter(call => !call.includes('|compose version'));
  assert.deepEqual(asked.map(call => call.slice(0, call.indexOf('|'))), [r.dockerHost, rootful],
    "the project's own rootless daemon the machine file names, then the rootful one");
  r.docker.compose('1.29.2');
  assertOneProblem(r.doctor(), /^Docker Compose v2 is missing \(docker compose version reports 1\.29\.2\).*Fix: install the docker-compose-plugin/);
  r.docker.compose(null);
  assertOneProblem(r.doctor(), /^Docker Compose v2 is missing \(docker compose version reports nothing\)/);
  r.docker.compose('2.32.4');
  r.docker.refuse(rootful, r.dockerHost);
  assertOneProblem(r.doctor(), new RegExp(`^The rootless Docker daemon of this project does not answer this user at ${r.dockerSocket} \\(docker info fails\\).*Fix: start the daemon user's docker.service`));
});

test("each project's doctor asks its own rootless daemon, and reports another project's key naming the same socket", t => {
  const r = doctorSetup(t);
  // The same machine's doctor for the project other-project asks that project's daemon, not triphammer's.
  r.docker.refuse(rootful, r.dockerHost);
  const asOther = r.doctor({TRIPHAMMER_PROJECT: 'other-project'});
  assert.equal(asOther.status, 0, asOther.output);
  const asked = r.docker.hosts().filter(call => call.endsWith('info --format {{.ServerVersion}}'));
  assert.deepEqual(asked.map(call => call.slice(0, call.indexOf('|'))), [`unix://${r.otherDockerSocket}`, rootful]);
  r.docker.refuse(rootful);

  writeFileSync(r.machineFile, `${readFileSync(r.machineFile, 'utf8')}TRIPHAMMER_DOCKER_SOCKET_THIRD=${r.dockerSocket}\n`);
  assertOneProblem(r.doctor(), new RegExp(`^The machine file .*/etc/triphammer\\.conf names ${r.dockerSocket}, this project's rootless Docker daemon, for another daemon too.*Fix: run sudo triphammer update`));
});

test("a daemon user's home whose unit directory is the user's, or that holds a unit provision-project did not write, is reported", t => {
  const r = doctorSetup(t);
  const {[r.daemonUnits]: _, ...owners} = r.owners;
  r.machineState({users: {'example-docker-triphammer': {home: r.dockerHome}}, owners});
  writeFileSync(join(r.daemonUnits, 'other.service'), '[Service]\nExecStart=/bin/true\n');
  mkdirSync(join(r.dockerHome, '.local/share/dbus-1'));
  assertOneProblem(r.doctor(), new RegExp(`^The home of this project's rootless Docker daemon's user is not as provision-project makes it \\(`
    + `${r.daemonUnits} is not root's with mode 755; ${r.daemonUnits}/other\\.service is not provision-project's; `
    + `${r.dockerHome}/\\.local/share/dbus-1 is not provision-project's\\), so a container on that daemon may have changed what its user runs\\. `
    + `Fix: look at each path named and remove what provision-project did not write, then run sudo triphammer update`));
});

test("a daemon user's home with a symlink for a directory, a unit the user owns, or no user the doctor can find is reported", t => {
  const r = doctorSetup(t);
  rmSync(join(r.dockerHome, '.local/share'), {recursive: true});
  symlinkSync(r.root, join(r.dockerHome, '.local/share'));
  const {[r.daemonUnit]: _, ...owners} = r.owners;
  r.machineState({users: {'example-docker-triphammer': {home: r.dockerHome}}, owners});
  assertOneProblem(r.doctor(), new RegExp(`\\(${r.dockerHome}/\\.local/share is not a directory; ${r.daemonUnit} is not a file root owns with mode 644\\)`));
  r.machineState({users: {}, owners});
  assertOneProblem(r.doctor(), /\(the machine has no user example-docker-triphammer, so the doctor cannot tell\)/);
});

test('a rootful Docker daemon that answers the service user is reported', t => {
  const r = doctorSetup(t);
  r.docker.refuse();
  assertOneProblem(r.doctor(), /^The rootful Docker daemon at \/var\/run\/docker\.sock answers this user.*Fix: take this user out of the docker group with sudo bin\/provision/);
});

test('a machine file that names no rootless Docker daemon is reported for a project that declares Docker', t => {
  const r = doctorSetup(t);
  r.noRootlessDaemon();
  assertOneProblem(r.doctor(), /^The machine file .*\/etc\/triphammer\.conf names no rootless Docker daemon of this project \(triphammer\), so no session of it starts.*Fix: run sudo triphammer update, whose bin\/provision-project/);
  assertOneProblem(r.doctor({TRIPHAMMER_PROJECT: 'Example_Project'}),
    /^The project name Example_Project cannot name a rootless Docker daemon of its own.*Fix: rename the project/);
});

test('a project that does not declare Docker gets no Docker checks', t => {
  const r = doctorSetup(t, {project: projectJson});
  r.docker.unavailable();
  const result = r.doctor();
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(r.docker.calls(), []);
});

// otherProject(r, name, pattern): a second project on the machine, with a config in the service user's
// ~/.config/triphammer and a checkout whose project file gives `pattern` as its composeProjectPattern (none when null).
function otherProject(r, name, pattern) {
  const checkout = join(r.root, `checkout-${name}`);
  mkdirSync(join(checkout, '.triphammer'), {recursive: true});
  const project = {...JSON.parse(projectJson), name, composeProjectPattern: pattern ?? undefined};
  writeFileSync(join(checkout, '.triphammer/project.json'), JSON.stringify(project));
  mkdirSync(join(r.home, '.config/triphammer'), {recursive: true});
  writeFileSync(join(r.home, `.config/triphammer/${name}.conf`),
    `REPO=Example-Owner/${name}\nCHECKOUT=${checkout}\nAPP_AUTHOR=app/example-agents\nSTATE_DIR=${join(r.root, `state-${name}`)}\n`);
}

test('two projects whose composeProjectPatterns can match the same Compose name are reported, naming both', t => {
  for (const pattern of ['^example-project-(local|it)-[0-9]+$', '^example-', '^example-project-local-[0-9]+$', 'local-[0-9]+',
    '^widgets-db|^example', '^e*xample', '^(widgets|example)-project-it-[0-9]+$', 'project-(local|it)', '^ex[ae]mple-']) {
    const r = doctorSetup(t);
    otherProject(r, 'other-project', pattern);
    assertOneProblem(r.doctor(), new RegExp(`^the composeProjectPattern of triphammer \\(\\^example-project-\\(local\\|it\\)-\\[0-9\\]\\+\\$\\) and that of other-project \\(${pattern.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\) can match the same Compose project name.*Fix: give each project's .*such as \\^triphammer- and \\^other-project-$`));
  }
});

test('projects whose composeProjectPatterns cannot match the same Compose name, or that give none, pass', t => {
  const r = doctorSetup(t);
  otherProject(r, 'other-project', '^widgets-db-[0-9]+$');
  otherProject(r, 'third-project', '^example-projects(x|y)[0-9]+$');
  otherProject(r, 'fourth-project', null);
  // A config whose checkout has no project file runs no sweep.
  writeFileSync(join(r.home, '.config/triphammer/fifth-project.conf'), `REPO=Example-Owner/fifth\nCHECKOUT=${join(r.root, 'nowhere')}\n`);
  // The project's own config, by name, is not another project.
  otherProject(r, 'triphammer', '^example-project-(local|it)-[0-9]+$');
  const result = r.doctor();
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('without a composeProjectPattern of its own, the project is not compared with others', t => {
  const r = doctorSetup(t);
  const project = JSON.parse(projectJson);
  delete project.composeProjectPattern;
  writeFileSync(join(r.checkout, '.triphammer/project.json'), JSON.stringify(project));
  git(r.checkout, 'commit', '-qam', 'no pattern');
  git(r.checkout, 'push', '-q', 'origin', 'main');
  otherProject(r, 'other-project', '^example-');
  const result = r.doctor();
  assert.equal(result.status, 0, result.output);
});

test('missing Playwright browsers are reported', t => {
  const r = doctorSetup(t);
  rmSync(join(r.browsers, 'chromium-1243'), {recursive: true});
  assertOneProblem(r.doctor(), /^Playwright's Chromium is not installed in .*Fix: run triphammer update, which installs it on a machine of its own; elsewhere run npx playwright install chromium/);
});

test('Chromium is checked only for a checkout whose tracked package.json, at any depth, pins Playwright', t => {
  const r = doctorSetup(t);
  rmSync(join(r.browsers, 'chromium-1243'), {recursive: true});
  r.publish('package.json', JSON.stringify({engines: {node: '>=24.19.0 <25'}, devDependencies: {typescript: '5.9.3'}}));
  git(r.checkout, 'pull', '-q', '--ff-only');
  const none = r.doctor();
  assert.equal(none.status, 0, none.output);
  assert.equal(none.output, 'all good\n');
  r.publish('web/package.json', JSON.stringify({dependencies: {playwright: '^1.63.0'}}));
  git(r.checkout, 'pull', '-q', '--ff-only');
  assertOneProblem(r.doctor(), /^Playwright's Chromium is not installed in /);
});

for (const name of ['git', 'jq', 'python3', 'shellcheck', 'gh', 'claude', 'node']) {
  test(`a missing ${name} is reported`, t => {
    const r = doctorSetup(t);
    // The doctor itself runs git, so its fake still does everything but report a version. jq is gone altogether:
    // the checks that read JSON with it are skipped rather than reported as false problems.
    r.broken(name, name === 'git' ? realCommand(name) : null);
    assertOneProblem(r.doctor(), new RegExp(`\\(${name}\\) is not installed or does not run on the units' PATH\\. Fix: install`));
  });
}

test('tools are looked up on the units\' PATH from ticket-runner@.service, not the caller\'s', t => {
  const r = doctorSetup(t);
  // A working node only on a caller's PATH directory the units never see, and a broken one in ~/.local/bin.
  const elsewhere = join(r.root, 'nvm');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'node'), readFileSync(join(r.bin, 'node')), {mode: 0o755});
  r.broken('node');
  const env = {PATH: `${elsewhere}:${r.env.PATH}`};
  assertOneProblem(r.doctor(env), /^Node \(node\) is not installed or does not run on the units' PATH\. Fix: install Node .*where the units' PATH finds it/);
  rmSync(join(r.checkout, 'systemd/ticket-runner@.service'));
  const result = r.doctor(env);
  assert.equal(result.status, 1, result.output);
  assert.match(result.problems[0], /ticket-runner@\.service is missing, unreadable or sets no PATH.*Fix: restore it/);
});

test('the units\' PATH is the last a drop-in sets, by file name, the project\'s own drop-in before the template\'s of that name', t => {
  const r = doctorSetup(t);
  // The project example-project's own rootless daemon, so the Docker checks find nothing to report.
  writeFileSync(r.machineFile, readFileSync(r.machineFile, 'utf8').replace(/^TRIPHAMMER_DOCKER_SOCKET_TRIPHAMMER=/m,
    'TRIPHAMMER_DOCKER_SOCKET_EXAMPLE_PROJECT=').replace(/^TRIPHAMMER_DOCKER_USER_TRIPHAMMER=/m, 'TRIPHAMMER_DOCKER_USER_EXAMPLE_PROJECT='));
  const doctor = () => r.doctor({TRIPHAMMER_PROJECT: 'example-project'});
  // A machine whose only SDK is ~/.dotnet's: the system directories on every PATH here can hold one of their own (CI
  // runners have /usr/bin/dotnet), so ~/.local/bin, first on each, finds dotnet only where the PATH reaches ~/.dotnet.
  writeFileSync(join(r.bin, 'dotnet'),
    '#!/bin/sh\ncase ":$PATH:" in *":$HOME/.dotnet:"*) exec "$HOME/.dotnet/dotnet" "$@" ;; esac\nexit 127\n', {mode: 0o755});
  const dropIns = unit => {
    mkdirSync(join(r.userUnits, `${unit}.service.d`), {recursive: true});
    return join(r.userUnits, `${unit}.service.d`);
  };
  const template = dropIns('ticket-runner@');
  rmSync(join(template, 'dotnet.conf'));
  assertOneProblem(doctor(), /^no \.NET SDK matches 10\.0\.400 .*\(~\/\.dotnet, with the drop-in of bin\/README\.md, Install, A project's toolchain\)$/);
  writeFileSync(join(template, 'dotnet.conf'), dotNetDropIn);
  writeFileSync(join(template, '50-other.conf'), '[Service]\nEnvironment=TZ=UTC\n');
  assert.equal(doctor().status, 0, 'a drop-in without PATH changed it');
  writeFileSync(join(template, 'zz-later.conf'), '[Service]\nEnvironment=PATH=%h/.local/bin:/usr/bin:/bin\n');
  assertOneProblem(doctor(), /^no \.NET SDK matches/);
  writeFileSync(join(dropIns('ticket-runner@other'), 'zz-later.conf'), dotNetDropIn);
  assertOneProblem(doctor(), /^no \.NET SDK matches/);
  writeFileSync(join(dropIns('ticket-runner@example-project'), 'zz-later.conf'), dotNetDropIn);
  const replaced = doctor();
  assert.equal(replaced.status, 0, replaced.output);
});

test('with a project in a repository of its own, the units\' PATH comes from Triphammer\'s checkout', t => {
  const r = doctorSetup(t);
  const project = r.separateProject();
  assert.equal(existsSync(join(project.checkout, 'systemd/ticket-runner@.service')), false);
  const result = r.doctor();
  assert.equal(result.status, 0, result.output);
  assert.equal(result.output, 'all good\n');
  rmSync(join(r.checkout, 'systemd/ticket-runner@.service'));
  const missing = r.doctor();
  assert.equal(missing.status, 1, missing.output);
  assert.equal(missing.problems[0], `${join(r.checkout, 'systemd/ticket-runner@.service')} is missing, unreadable or sets no PATH, `
    + 'so the tools were looked up on the caller\'s PATH. Fix: restore it from origin/main in Triphammer\'s checkout '
    + `(git -C ${r.checkout} checkout origin/main -- systemd/ticket-runner@.service)`);
});

test('a python3 that is not Python 3 is reported', t => {
  const r = doctorSetup(t);
  writeFileSync(join(r.bin, 'python3'), '#!/bin/sh\necho "Python 2.7.18"\n', {mode: 0o755});
  assertOneProblem(r.doctor(), /^python3 is Python 2\.7\.18, not Python 3\. Fix: install Python 3/);
});

test('Codex is checked only when the codex module is on: installed and logged in', t => {
  const off = doctorSetup(t);
  off.broken('codex');
  assert.equal(off.doctor().status, 0);
  const on = doctorSetup(t, {config: {MODULES: 'codex'}});
  assertOneProblem(on.doctor({FAKE_CODEX_LOGIN_EXIT: '1'}), /^Codex is not logged in\. Fix: run codex login/);
  on.broken('codex');
  assertOneProblem(on.doctor(), /^Codex \(codex\) is not installed or does not run on the units' PATH\. Fix: install the Codex CLI/);
});

test('gh that does not act as the App is reported', t => {
  const r = doctorSetup(t);
  r.gh.respond({'api installation/repositories': {exit: 1, stderr: 'HTTP 403\n'}});
  assertOneProblem(r.doctor(), /^gh does not act as the agents' GitHub App on Example-Owner, the owner of Example-Owner\/example-project .*Fix: install the App on Example-Owner, link bin\/gh and github-app-token/);
  assert.ok(!r.gh.calls().some(call => call[0] === 'label'), 'the labels were looked up without the App');
  assert.ok(!r.gh.calls().some(call => call[1]?.startsWith('repos/')), 'the repository was read without the App');
});

test('a repository that keeps head branches after merge is reported, with the owner\'s setting as the fix', t => {
  const r = doctorSetup(t);
  r.gh.respond({'api repos/': {file: 'repo.json'}});
  r.gh.json('repo.json', {full_name: 'Example-Owner/example-project', delete_branch_on_merge: true});
  const on = r.doctor();
  assert.equal(on.status, 0, on.output);
  r.gh.json('repo.json', {full_name: 'Example-Owner/example-project', delete_branch_on_merge: false});
  assertOneProblem(r.doctor(), new RegExp('^Example-Owner/example-project keeps head branches after their pull requests merge '
    + '\\(delete_branch_on_merge is off\\)\\. Fix: the owner turns on Automatically delete head branches in the repository\'s '
    + 'settings, or runs gh api -X PATCH repos/Example-Owner/example-project -F delete_branch_on_merge=true '));
  // The doctor only reads the setting.
  assert.ok(!r.gh.calls().some(call => call.includes('-X') || call.includes('PATCH')), 'the doctor changed the repository');
});

for (const [name, answer] of [
  ['an answer without the setting', {file: 'repo.json'}],
  ['an answer whose setting is not a boolean', {file: 'repo.json', value: 'true'}],
  ['a failing call', {exit: 1, stderr: 'HTTP 403\n'}],
]) {
  test(`${name} for delete_branch_on_merge is reported as not checked, never as on`, t => {
    const r = doctorSetup(t);
    const {value, ...route} = answer;
    r.gh.json('repo.json', {full_name: 'Example-Owner/example-project', ...(value === undefined ? {} : {delete_branch_on_merge: value})});
    r.gh.respond({'api repos/': route});
    assertOneProblem(r.doctor(), new RegExp('^gh api repos/Example-Owner/example-project gives no delete_branch_on_merge, '
      + 'so whether Example-Owner/example-project deletes head branches after merge was not checked\\. Fix: the owner checks '
      + 'Automatically delete head branches'));
  });
}

test('the labels and the head branch setting are checked independently', t => {
  const r = doctorSetup(t);
  r.gh.respond({'label list': {exit: 1, stderr: 'HTTP 404\n'}, 'api repos/': {stdout: 'false\n'}});
  const result = r.doctor();
  assert.equal(result.problems.length, 2, result.output);
  assert.match(result.problems[0], /^gh label list fails for /);
  assert.match(result.problems[1], /keeps head branches after their pull requests merge/);
});

test('the App check gets its token for the owner of REPO, not the owner file\'s account', t => {
  // The real gh wrapper and github-app-token, ahead of the fake gh (moved to ~/.dotnet, later on the units' PATH), with
  // the App installed on acct-a only, the account the owner file names.
  const r = doctorSetup(t, {config: {REPO: 'acct-b/example-project'}});
  const fake = readFileSync(join(r.bin, 'gh'), 'utf8');
  writeFileSync(join(r.home, '.dotnet/gh'), fake, {mode: 0o755});
  rmSync(join(r.bin, 'gh'));
  symlinkSync(join(here, 'gh'), join(r.bin, 'gh'));
  writeFileSync(join(r.app, 'app-id'), '12345\n');
  writeFileSync(join(r.app, 'owner'), 'acct-a\n');
  rmSync(join(r.app, 'agents.pem'));
  run('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', join(r.app, 'agents.pem')]);
  chmodSync(join(r.app, 'agents.pem'), 0o600);
  const installedOn = login => r.curlRoutes({[`GET ${qwenUrl}`]: {},
    'GET https://api.github.com/app/installations': {stdout: JSON.stringify([{id: 41, account: {login}}])},
    'POST https://api.github.com/app/installations/41/access_tokens':
      {stdout: JSON.stringify({token: 'ghs_test', expires_at: '2999-01-01T00:00:00Z'})}});
  installedOn('acct-a');
  assertOneProblem(r.doctor({XDG_CACHE_HOME: join(r.root, 'cache')}),
    /^gh does not act as the agents' GitHub App on acct-b, the owner of acct-b\/example-project \(gh api installation\/repositories fails\)\. Fix: install the App on acct-b, /);
  assert.deepEqual(r.gh.calls(), [['--version']], 'gh ran with a token of another account\'s installation');
  // Installed on acct-b as well, the check passes as acct-b.
  installedOn('acct-b');
  const result = r.doctor({XDG_CACHE_HOME: join(r.root, 'cache')});
  assert.equal(result.status, 0, result.output);
});

test('each label Triphammer uses that the repository lacks is reported, with triphammer add as the fix', t => {
  const r = doctorSetup(t);
  r.gh.respond({'label list': {stdout: 'bug\nnext\nAgent-Working\n'}});
  const result = r.doctor();
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(result.problems, ['hold', 'needs-owner', 'stop-agents', 'light', 'cleanup'].map(name =>
    `Example-Owner/example-project has no label ${name}, which Triphammer reads or sets. Fix: run triphammer add `
    + 'Example-Owner/example-project again, with the options it was added with (bin/README.md, Labels)'));
  assert.match(result.output, /^5 problem\(s\) found$/m);
  r.gh.respond({'label list': {stdout: ''}});
  assert.equal(r.doctor().problems.length, 7);
});

test('labels that cannot be listed are reported, not passed', t => {
  const r = doctorSetup(t);
  r.gh.respond({'label list': {exit: 1, stderr: 'HTTP 404\n'}});
  assertOneProblem(r.doctor(),
    /^gh label list fails for Example-Owner\/example-project, so the labels Triphammer uses were not checked\. Fix: install the agents' GitHub App/);
});

test('Claude Code that is not logged in is reported', t => {
  const r = doctorSetup(t);
  assertOneProblem(r.doctor({FAKE_CLAUDE_LOGGED_OUT: '1'}), /^Claude Code is not logged in\. Fix: run claude auth login/);
});

for (const [missing, present] of [['triphammer@triphammer', 'humanizer@humanizer'], ['humanizer@humanizer', 'triphammer@triphammer']]) {
  test(`a missing ${missing} plugin is reported, with the installer as its fix`, t => {
    const r = doctorSetup(t);
    // At project scope it does not count: provision installs at user scope.
    writeFileSync(join(r.root, 'sessions/plugins.json'), JSON.stringify({marketplaces: [],
      plugins: [{id: present, scope: 'user'}, {id: missing, scope: 'project'}]}));
    assertOneProblem(r.doctor(), new RegExp(`^the Claude Code plugin ${missing} is not installed at user scope for this user\\. `
      + 'Fix: run the installer again'));
  });
}

test('both plugins present pass, and a plugin list that fails is reported, not passed', t => {
  const r = doctorSetup(t);
  const both = r.doctor();
  assert.equal(both.status, 0, both.output);
  const calls = lines(join(r.root, 'sessions/plugin-calls')).map(line => JSON.parse(line).args.join(' '));
  assert.deepEqual(calls, ['list --json']);
  writeFileSync(join(r.root, 'sessions/plugins.json'), 'not json');
  assertOneProblem(r.doctor(), /^claude plugin list fails, so the plugins triphammer@triphammer humanizer@humanizer were not checked\. Fix: run the installer again/);
});

test('a missing App file, one of the wrong mode and one that is a directory are reported by path, never by content', t => {
  const r = doctorSetup(t);
  rmSync(join(r.app, 'agents.pem'));
  chmodSync(join(r.app, 'owner'), 0o644);
  const result = r.doctor();
  assert.equal(result.status, 1);
  assert.deepEqual(result.problems.map(line => line.replaceAll(r.app, '<app>')), [
    "<app>/owner has mode 644, not 600. Fix: chmod 600 <app>/owner",
    "<app>/agents.pem is missing. Fix: the owner fills in the App's agents.pem, mode 600 (bin/README.md, Install)",
  ]);
  rmSync(join(r.app, 'app-id'));
  mkdirSync(join(r.app, 'app-id'));
  assert.match(r.doctor().output, /\/app-id is not a regular file\. Fix: /);
});

test('with qwen-audit on, the Qwen key file is checked and an unreachable QWEN_BASE_URL is reported', t => {
  const r = doctorSetup(t, {config: {...allModules, MODULES: 'qwen-audit'}});
  writeConfig(r);
  chmodSync(r.qwenKey, 0o640);
  assertOneProblem(r.doctor(), /qwen-key has mode 640, not 600\. Fix: chmod 600 /);
  chmodSync(r.qwenKey, 0o600);
  r.curlRoutes({[`GET ${qwenUrl}`]: {exit: 7, stderr: 'curl: (7) Failed to connect\n'}});
  assertOneProblem(r.doctor(), /^QWEN_BASE_URL http:\/\/model\.example\.invalid:8080 does not answer\. Fix: start the model server/);
});

test('a unit that is not enabled is reported, the gallery unit only with the demo module on', t => {
  const r = doctorSetup(t);
  r.answers('systemctl', {'--user is-enabled': {stdout: 'enabled\n'},
    '--user is-enabled merge-when-ready@': {stdout: 'disabled\n', exit: 1},
    '--user is-enabled demo-gallery@': {stdout: 'not-found\n', exit: 1}});
  assertOneProblem(r.doctor(),
    /^the unit merge-when-ready@triphammer\.timer is disabled\. Fix: link the template unit and run systemctl --user enable --now merge-when-ready@triphammer\.timer/);
  writeFileSync(r.configFile, `${readFileSync(r.configFile, 'utf8')}MODULES=demo\nDEMO_URL=http://gallery.example.invalid/\n`);
  const result = r.doctor();
  assert.equal(result.problems.length, 2, result.output);
  assert.match(result.problems[1], /^the unit demo-gallery@triphammer\.service is not-found\. Fix: /);
});

test('before start, the doctor leaves the units out and says so, naming them', t => {
  const r = doctorSetup(t, {config: {MODULES: 'demo', DEMO_URL: 'http://gallery.example.invalid/', DEMO_GALLERY_DIR: '/nonexistent/gallery'}});
  r.answers('systemctl', {'--user is-enabled': {stdout: 'disabled\n', exit: 1}});
  const result = r.doctor({}, ['--before-start']);
  assert.equal(result.status, 0, result.output);
  assert.equal(result.output, 'left out the units ticket-runner@triphammer.timer merge-when-ready@triphammer.timer '
    + 'demo-gallery@triphammer.service, which triphammer start triphammer enables\nall good\n');
  assert.equal(existsSync(join(r.root, 'systemctl/calls')), false, 'the doctor asked systemctl about a unit');
  assert.equal(r.doctor().problems.length, 3);
  const wrong = r.doctor({}, ['--after-start']);
  assert.equal(wrong.status, 2, wrong.output);
  assert.match(wrong.output, /^usage: ticket-runner --doctor \[--before-start\]$/m);
});

test('a user without a git commit identity is reported, name and email each, and one with it passes', t => {
  const r = doctorSetup(t);
  const result = r.doctor({GIT_CONFIG_GLOBAL: '/dev/null'});
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(result.problems.map(line => line.replace(/\. Fix: .*/, '')),
    ['git has no user.name for this user, so it may refuse to commit', 'git has no user.email for this user, so it may refuse to commit']);
  assert.match(result.problems[0], /Fix: set it with git config --global user\.name, as triphammer add does from APP_AUTHOR/);
  writeFileSync(join(r.root, 'only-name'), '[user]\n\tname = someone\n');
  assertOneProblem(r.doctor({GIT_CONFIG_GLOBAL: join(r.root, 'only-name')}), /^git has no user\.email /);
});

test('a checkout off main, with changes, or not at origin/main is reported', t => {
  const r = doctorSetup(t);
  writeFileSync(join(r.checkout, 'stray'), 'x\n');
  assertOneProblem(r.doctor(), /has uncommitted or untracked changes\. Fix: commit, move or remove them/);
  rmSync(join(r.checkout, 'stray'));
  r.publish('bin/x', 'v2\n');
  assertOneProblem(r.doctor(), /is not at origin\/main\. Fix: git -C .* merge --ff-only origin\/main/);
  git(r.checkout, 'merge', '-q', '--ff-only', 'origin/main');
  git(r.checkout, 'switch', '-q', '-c', 'side');
  assertOneProblem(r.doctor(), /is on side, not main\. Fix: git -C .* switch main/);
});

test('a missing Triphammer config stops the doctor with exit 2 and the config\'s own message', t => {
  const r = doctorSetup(t);
  rmSync(r.configFile);
  const result = r.doctor();
  assert.equal(result.status, 2);
  assert.match(result.output, /ticket-runner --doctor: the Triphammer config .* is missing or unreadable/);
});
