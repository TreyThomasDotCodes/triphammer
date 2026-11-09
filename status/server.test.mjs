import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {deviceNumbers, isLocked, parseProcLocks, processStartMs} from './locks.mjs';
import {listRuns, parseRunName} from './runs.mjs';
import {handler, isAllowedHost, parseConfig} from './server.mjs';
import {readTriphammerConfig, sharedDir} from './config.mjs';
import {cached, commandsFor, readRuns} from './state.mjs';
import {formatAge} from './render.mjs';
import {decisionText} from './waiting.mjs';

/**
 * A command that succeeded with `value` as its JSON output, as `gh` answers.
 * @param {unknown} value
 */
const ok = value => ({ok: /** @type {const} */ (true), stdout: JSON.stringify(value)});

const procLocks = `1: FLOCK  ADVISORY  WRITE 2484318 103:02:110755898 0 EOF
2: POSIX  ADVISORY  WRITE 276787 103:02:18482137 0 0
3: -> FLOCK  ADVISORY  WRITE 99 fd:01:42 0 EOF
`;

test('reads /proc/locks devices as hex and ignores blocked waiters', () => {
  assert.deepEqual(parseProcLocks(procLocks).map(lock => [lock.major, lock.minor, lock.inode]),
    [[259, 2, 110755898n], [259, 2, 18482137n]]);
  assert.deepEqual(deviceNumbers(66306n), {major: 259, minor: 2});
  assert.equal(isLocked(procLocks, {dev: 66306n, ino: 110755898n}), true);
  assert.equal(isLocked(procLocks, {dev: 66306n, ino: 1n}), false);
  assert.equal(isLocked(procLocks, {dev: 0xfd01n, ino: 42n}), false);
});

test('reads a process start time from field 22 of its stat, even with spaces and parentheses in the name', () => {
  const stat = `7 (a) b (c) S ${Array(18).fill('0').join(' ')} 12345 0 0\n`;
  assert.equal(processStartMs(stat, 1_000), 1_123_450);
  assert.equal(processStartMs('7 (a) S\n', 1_000), null);
});

test('accepts only the runner\'s run-name pattern', () => {
  assert.deepEqual(parseRunName('20260102T100000Z-repair-12'),
    {name: '20260102T100000Z-repair-12', kind: 'repair', number: 12, started: '2026-01-02T10:00:00Z'});
  for (const bad of ['../log', '20260102T100000Z-ticket-7.jsonl', '20260102T100000Z-other-7', '20260102T100000Z-ticket-7/x', '']) {
    assert.equal(parseRunName(bad), null, bad);
  }
});

// A Triphammer config file in a temporary directory with `text`, removed after the test.
function configFile(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triphammer-status-config-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'solo.conf'), text);
  return path.join(dir, 'solo.conf');
}
const settings = 'REPO=acme/widgets\nCHECKOUT=/srv/widgets\nAPP_AUTHOR=app/widget-bot\nSTATE_DIR=/srv/state/runner\n';

test('flags beat environment variables, which beat defaults; the project comes from the Triphammer config TRIPHAMMER_CONFIG names', t => {
  const TRIPHAMMER_CONFIG = configFile(t, settings);
  const env = {TRIPHAMMER_CONFIG, XDG_STATE_HOME: '/xdg', STATUS_PORT: '9000', STATUS_RUNNER: '/bin/runner', STATUS_ALLOWED_HOSTS: ' Status.Example , ,box.ts.net:443'};
  assert.deepEqual(parseConfig(['--port=9100', '--host', '0.0.0.0'], env), {
    host: '0.0.0.0', port: 9100, allowedHosts: ['status.example', 'box.ts.net:443'], runner: '/bin/runner', gh: 'gh', sharedDir: '/xdg/triphammer',
    projects: [{name: 'solo', ok: true, repo: 'acme/widgets', stateDir: '/srv/state/runner', env,
      listen: {STATUS_HOST: '', STATUS_PORT: '', STATUS_ALLOWED_HOSTS: ''}}],
  });
  assert.equal(parseConfig([], {TRIPHAMMER_CONFIG}).port, 8787);
  assert.deepEqual(parseConfig([], {TRIPHAMMER_CONFIG}).allowedHosts, []);
  assert.throws(() => parseConfig(['--nope'], {TRIPHAMMER_CONFIG}), /unknown argument/);
  assert.throws(() => parseConfig(['--port', 'x'], {TRIPHAMMER_CONFIG}), /bad port/);
  for (const flag of ['--repo', '--state-dir']) assert.throws(() => parseConfig([flag, 'x'], {TRIPHAMMER_CONFIG}), /unknown argument/);
});

test('the address, port and allowed names come from the Triphammer config when no flag or environment variable gives them', t => {
  const TRIPHAMMER_CONFIG = configFile(t, `${settings}STATUS_HOST=0.0.0.0\nSTATUS_PORT=9200\nSTATUS_ALLOWED_HOSTS=Status.Example,[::1]:8443\n`);
  const fromConfig = parseConfig([], {TRIPHAMMER_CONFIG});
  assert.deepEqual([fromConfig.host, fromConfig.port, fromConfig.allowedHosts], ['0.0.0.0', 9200, ['status.example', '[::1]:8443']]);
  const fromEnv = parseConfig([], {TRIPHAMMER_CONFIG, STATUS_HOST: '127.0.0.2', STATUS_PORT: '9300', STATUS_ALLOWED_HOSTS: 'other.example'});
  assert.deepEqual([fromEnv.host, fromEnv.port, fromEnv.allowedHosts], ['127.0.0.2', 9300, ['other.example']]);
  const fromFlags = parseConfig(['--host', '127.0.0.3', '--port', '9400', '--allowed-hosts', 'flag.example'], {TRIPHAMMER_CONFIG, STATUS_PORT: '9300'});
  assert.deepEqual([fromFlags.host, fromFlags.port, fromFlags.allowedHosts], ['127.0.0.3', 9400, ['flag.example']]);
  const unset = parseConfig([], {TRIPHAMMER_CONFIG: configFile(t, `${settings}STATUS_HOST=\n`)});
  assert.deepEqual([unset.host, unset.port, unset.allowedHosts], ['127.0.0.1', 8787, []]);
});

test('the listen settings the discovered configs agree on are used, and configs that disagree stop the server', t => {
  const xdg = configHome(t, {
    widgets: `${settings}STATUS_HOST=0.0.0.0\nSTATUS_PORT=9200\n`,
    gadgets: `${settings}STATUS_PORT=9200\nSTATUS_ALLOWED_HOSTS=status.example\n`,
    plain: settings,
    broken: settings.replace(/^STATE_DIR=.*\n/m, ''),
  });
  const env = {PATH: process.env.PATH, XDG_CONFIG_HOME: xdg};
  const agreed = parseConfig([], env);
  assert.deepEqual([agreed.host, agreed.port, agreed.allowedHosts], ['0.0.0.0', 9200, ['status.example']]);
  fs.writeFileSync(path.join(xdg, 'triphammer', 'plain.conf'), `${settings}STATUS_PORT=9300\n`);
  assert.throws(() => parseConfig([], env),
    {message: 'the project configs set STATUS_PORT to different values (gadgets: 9200, plain: 9300, widgets: 9200); set it the same in each, or in one only'});
  // A flag or environment variable does not settle a disagreement: the configs stay ambiguous, so the server refuses.
  assert.throws(() => parseConfig(['--port', '9400'], {...env, STATUS_PORT: '9500'}), /set STATUS_PORT to different values/);
});

test('the server exits 2 naming the setting when the project configs disagree on where it listens', t => {
  const xdg = configHome(t, {widgets: `${settings}STATUS_HOST=127.0.0.1\n`, gadgets: `${settings}STATUS_HOST=0.0.0.0\n`});
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, 'server.mjs')],
    {encoding: 'utf8', env: {PATH: process.env.PATH, XDG_CONFIG_HOME: xdg}, timeout: 10000});
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^triphammer-status: the project configs set STATUS_HOST to different values \(gadgets: 0\.0\.0\.0, widgets: 127\.0\.0\.1\)/);
});

test('a missing or malformed Triphammer config is refused, naming the file and the setting', t => {
  const missing = path.join(os.tmpdir(), 'triphammer-status-no-such-dir', 'solo.conf');
  assert.throws(() => parseConfig([], {TRIPHAMMER_CONFIG: missing}), new RegExp(`the Triphammer config ${missing} is missing or unreadable`));
  const noState = configFile(t, settings.replace(/^STATE_DIR=.*\n/m, ''));
  assert.throws(() => parseConfig([], {TRIPHAMMER_CONFIG: noState}), new RegExp(`${noState} does not set STATE_DIR`));
});

// The Triphammer config's grammar and checks (bin/README.md, "Configuration") are config.sh's; the status page
// reads the config through it, so these cases cover both.
test('the Triphammer config keeps values verbatim and skips comments, blank lines and the newline the last line lacks', t => {
  const text = '# the widgets project\n\n   \nREPO=acme/widgets\n\t# indented comment\nCHECKOUT=/srv/a b=#c\nAPP_AUTHOR=app/widget-bot\nSTATE_DIR=/srv/state/runner';
  assert.deepEqual(readTriphammerConfig({TRIPHAMMER_CONFIG: configFile(t, text)}),
    {REPO: 'acme/widgets', CHECKOUT: '/srv/a b=#c', APP_AUTHOR: 'app/widget-bot', STATE_DIR: '/srv/state/runner', PROJECT: 'solo',
      STATUS_HOST: '', STATUS_PORT: '', STATUS_ALLOWED_HOSTS: ''});
});

test('the Triphammer config accepts every module and its settings, and an empty MODULES or a module setting left while it is off', t => {
  const optional = 'MODULES=codex,demo,qwen-audit\nDEMO_GALLERY_DIR=/srv/gallery\nDEMO_URL=http://demos.example.invalid:8888/\n'
    + 'QWEN_BASE_URL=http://localhost:8080\nQWEN_KEY_FILE=/srv/secrets/qwen key\nQWEN_MODEL=org/qwen-test:q4_k\n'
    + 'CODEX_AUDIT_MODEL=codex-audit-test\nCODEX_SECURITY_MODEL=codex-security-test-latest\nCODEX_WEEKLY_CAP=0\n'
    + 'CODEX_FLOOR_PERCENT=100\nCODEX_RUN_PERCENT=7\nSTATUS_HOST=::\nSTATUS_PORT=65535\n'
    + 'STATUS_ALLOWED_HOSTS=status.example,[::1]:8443\nDEMO_GALLERY_HOST=gallery.example.invalid\nDEMO_GALLERY_PORT=1\n';
  const expected = {REPO: 'acme/widgets', CHECKOUT: '/srv/widgets', APP_AUTHOR: 'app/widget-bot', STATE_DIR: '/srv/state/runner', PROJECT: 'solo'};
  for (const [text, listen] of [
    [settings + optional, {STATUS_HOST: '::', STATUS_PORT: '65535', STATUS_ALLOWED_HOSTS: 'status.example,[::1]:8443'}],
    [`${settings}MODULES=\nQWEN_MODEL=org/qwen-test\n`, {STATUS_HOST: '', STATUS_PORT: '', STATUS_ALLOWED_HOSTS: ''}],
  ]) {
    assert.deepEqual(readTriphammerConfig({TRIPHAMMER_CONFIG: configFile(t, text)}), {...expected, ...listen}, text);
  }
});

test('a malformed Triphammer config line or value is refused with exactly the message config.sh prints', t => {
  for (const [text, message] of [
    [`export ${settings}`, file => `${file} line 1 is not KEY=value`],
    [` ${settings}`, file => `${file} line 1 is not KEY=value`],
    [`repo=acme/widgets\n${settings}`, file => `${file} line 1 is not KEY=value`],
    [`${settings}REPO = acme/widgets\n`, file => `${file} line 5 is not KEY=value`],
    [`${settings}SERVED=acme/widgets\n`, file => `${file} line 5 sets SERVED, which is not a config setting`],
    [`${settings}REPO=acme/other\n`, file => `${file} line 5 sets REPO a second time`],
    [settings.replace('APP_AUTHOR=app/widget-bot', 'APP_AUTHOR='), file => `${file} does not set APP_AUTHOR`],
    [settings.replace('REPO=acme/widgets', 'REPO=acme'), file => `${file}: REPO must be owner/name, not acme`],
    [settings.replace('STATE_DIR=/srv/state/runner', 'STATE_DIR=~/state'), file => `${file}: STATE_DIR must be an absolute path, not ~/state`],
    [settings.replace('CHECKOUT=/srv/widgets', 'CHECKOUT=srv'), file => `${file}: CHECKOUT must be an absolute path, not srv`],
    [settings.replace('APP_AUTHOR=app/widget-bot', 'APP_AUTHOR=app/widget bot'), file => `${file}: APP_AUTHOR must be one login, not app/widget bot`],
    [`${settings}MODULES=demo, codex\n`, file => `${file}: MODULES must be module names separated by commas, not demo, codex`],
    [`${settings}MODULES=demo,\n`, file => `${file}: MODULES must be module names separated by commas, not demo,`],
    [`${settings}MODULES=Demo\n`, file => `${file}: MODULES must be module names separated by commas, not Demo`],
    [`${settings}MODULES=demo,gallery\n`, file => `${file}: MODULES names gallery, which is not a module (demo qwen-audit codex)`],
    [`${settings}MODULES=codex,demo,codex\n`, file => `${file}: MODULES names codex twice`],
    [`${settings}MODULES=demo\nMODULES=codex\n`, file => `${file} line 6 sets MODULES a second time`],
    [`${settings}DEMO_GALLERY_DIR=demos\n`, file => `${file}: DEMO_GALLERY_DIR must be an absolute path, not demos`],
    [`${settings}QWEN_KEY_FILE=~/key\n`, file => `${file}: QWEN_KEY_FILE must be an absolute path, not ~/key`],
    [`${settings}DEMO_URL=demos.example.invalid\n`, file => `${file}: DEMO_URL must be an http or https URL, not demos.example.invalid`],
    [`${settings}QWEN_BASE_URL=http://host /v1\n`, file => `${file}: QWEN_BASE_URL must be an http or https URL, not http://host /v1`],
    [`${settings}QWEN_MODEL=qwen; rm\n`, file => `${file}: QWEN_MODEL must be a model name, not qwen; rm`],
    [`${settings}CODEX_AUDIT_MODEL=a b\n`, file => `${file}: CODEX_AUDIT_MODEL must be a model name, not a b`],
    [`${settings}CODEX_SECURITY_MODEL=$(x)\n`, file => `${file}: CODEX_SECURITY_MODEL must be a model name, not $(x)`],
    [`${settings}CODEX_WEEKLY_CAP=lots\n`, file => `${file}: CODEX_WEEKLY_CAP must be a whole number, not lots`],
    [`${settings}CODEX_FLOOR_PERCENT=101\n`, file => `${file}: CODEX_FLOOR_PERCENT must be a whole number from 0 to 100, not 101`],
    [`${settings}CODEX_RUN_PERCENT=-5\n`, file => `${file}: CODEX_RUN_PERCENT must be a whole number from 0 to 100, not -5`],
    [`${settings}CODEX_WEEKLY_CAP=08\n`, file => `${file}: CODEX_WEEKLY_CAP must be a whole number, not 08`],
    [`${settings}CODEX_FLOOR_PERCENT=08\n`, file => `${file}: CODEX_FLOOR_PERCENT must be a whole number from 0 to 100, not 08`],
    [`${settings}CODEX_RUN_PERCENT=08\n`, file => `${file}: CODEX_RUN_PERCENT must be a whole number from 0 to 100, not 08`],
    [`${settings}CODEX_RUN_PERCENT=00\n`, file => `${file}: CODEX_RUN_PERCENT must be a whole number from 0 to 100, not 00`],
    [`${settings}STATUS_HOST=bad host\n`, file => `${file}: STATUS_HOST must be an address or host name (letters, digits and ._:-), not bad host`],
    [`${settings}DEMO_GALLERY_HOST=$(x)\n`, file => `${file}: DEMO_GALLERY_HOST must be an address or host name (letters, digits and ._:-), not $(x)`],
    [`${settings}STATUS_PORT=0\n`, file => `${file}: STATUS_PORT must be a port from 1 to 65535, not 0`],
    [`${settings}STATUS_PORT=65536\n`, file => `${file}: STATUS_PORT must be a port from 1 to 65535, not 65536`],
    [`${settings}DEMO_GALLERY_PORT=http\n`, file => `${file}: DEMO_GALLERY_PORT must be a port from 1 to 65535, not http`],
    [`${settings}DEMO_GALLERY_PORT=123456\n`, file => `${file}: DEMO_GALLERY_PORT must be a port from 1 to 65535, not 123456`],
    [`${settings}STATUS_ALLOWED_HOSTS=status.example, box\n`, file => `${file}: STATUS_ALLOWED_HOSTS must be host names separated by commas, no blanks, not status.example, box`],
    [`${settings}STATUS_ALLOWED_HOSTS=status.example,\n`, file => `${file}: STATUS_ALLOWED_HOSTS must be host names separated by commas, no blanks, not status.example,`],
  ]) {
    const file = configFile(t, text);
    assert.throws(() => parseConfig([], {TRIPHAMMER_CONFIG: file}), {message: message(file)}, text);
  }
});

/**
 * A config directory under a temporary XDG_CONFIG_HOME holding `<name>.conf` for each entry, removed after the test.
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string>} configs
 */
function configHome(t, configs) {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'triphammer-status-xdg-'));
  t.after(() => fs.rmSync(xdg, {recursive: true, force: true}));
  fs.mkdirSync(path.join(xdg, 'triphammer'));
  for (const [name, text] of Object.entries(configs)) fs.writeFileSync(path.join(xdg, 'triphammer', `${name}.conf`), text);
  return xdg;
}

test('without TRIPHAMMER_CONFIG or TRIPHAMMER_PROJECT the page shows every <name>.conf under XDG_CONFIG_HOME, a bad one as its error', t => {
  const xdg = configHome(t, {
    widgets: settings,
    gadgets: settings.replace('acme/widgets', 'acme/gadgets').replace('/srv/state/runner', '/srv/state/gadgets'),
    broken: settings.replace(/^STATE_DIR=.*\n/m, ''),
  });
  fs.writeFileSync(path.join(xdg, 'triphammer', 'notes.txt'), 'not a config');
  const env = {PATH: process.env.PATH, XDG_CONFIG_HOME: xdg};
  const {projects} = parseConfig([], env);
  assert.deepEqual(projects.map(project => (project.ok ? [project.name, project.repo, project.stateDir, project.env.TRIPHAMMER_PROJECT] : [project.name, project.error])), [
    ['broken', `${path.join(xdg, 'triphammer', 'broken.conf')} does not set STATE_DIR`],
    ['gadgets', 'acme/gadgets', '/srv/state/gadgets', 'gadgets'],
    ['widgets', 'acme/widgets', '/srv/state/runner', 'widgets'],
  ]);
  // ~/.config is the directory when XDG_CONFIG_HOME is unset or empty, as for config.sh.
  fs.mkdirSync(path.join(xdg, 'home', '.config'), {recursive: true});
  fs.renameSync(path.join(xdg, 'triphammer'), path.join(xdg, 'home', '.config', 'triphammer'));
  const home = parseConfig([], {PATH: process.env.PATH, HOME: path.join(xdg, 'home'), XDG_CONFIG_HOME: ''}).projects;
  assert.deepEqual(home.map(project => [project.name, project.ok]), [['broken', false], ['gadgets', true], ['widgets', true]]);
});

test('discovery fails when the config directory cannot be listed or holds no config, and TRIPHAMMER_PROJECT selects one', t => {
  const xdg = configHome(t, {widgets: settings});
  const env = {PATH: process.env.PATH, XDG_CONFIG_HOME: xdg};
  assert.deepEqual(parseConfig([], {...env, TRIPHAMMER_PROJECT: 'widgets'}).projects.map(project => project.name), ['widgets']);
  assert.throws(() => parseConfig([], {...env, TRIPHAMMER_PROJECT: 'gadgets'}), /gadgets\.conf is missing or unreadable/);
  assert.throws(() => parseConfig([], {...env, XDG_CONFIG_HOME: path.join(xdg, 'other')}),
    new RegExp(`cannot list the project configs in ${path.join(xdg, 'other', 'triphammer')}`));
  fs.rmSync(path.join(xdg, 'triphammer', 'widgets.conf'));
  assert.throws(() => parseConfig([], env), {message: `${path.join(xdg, 'triphammer')} holds no Triphammer config; create <project>.conf with REPO, CHECKOUT, APP_AUTHOR and STATE_DIR (bin/README.md)`});
});

test('the shared directory is the one config.sh names', t => {
  const TRIPHAMMER_CONFIG = configFile(t, settings);
  const reader = path.join(import.meta.dirname, '..', 'bin', 'config.sh');
  for (const env of [{TRIPHAMMER_SHARED_DIR: '/shared/dir', XDG_STATE_HOME: '/xdg'}, {XDG_STATE_HOME: '/xdg'}, {XDG_STATE_HOME: '', HOME: '/home/owner'}]) {
    const result = spawnSync('bash', ['-c', 'source "$1" && load_config test /nowhere && printf %s "$cfg_shared_dir"', 'bash', reader],
      {encoding: 'utf8', env: {PATH: process.env.PATH, TRIPHAMMER_CONFIG, ...env}});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(sharedDir(env), result.stdout, JSON.stringify(env));
  }
});

test('serves a stale cached value while one refresh runs', async () => {
  let clock = 0;
  let loads = 0;
  const get = cached(60, async () => ++loads, () => clock);
  assert.equal((await get()).value, 1);
  clock = 30;
  assert.equal((await get()).value, 1);
  clock = 100;
  assert.equal((await get()).value, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await get()).value, 2);
  assert.equal(loads, 2);
});

/** Builds a small state directory with a held lock and a running ticket. */
function stateDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triphammer-status-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.mkdirSync(path.join(dir, 'runs'));
  const run = '20260102T130000Z-ticket-9';
  fs.writeFileSync(path.join(dir, 'runs', `${run}.jsonl`),
    '{"type":"assistant","message":{"content":[{"type":"text","text":"<b>hi</b>"}]}}\n');
  fs.writeFileSync(path.join(dir, 'runs', 'notes.txt'), 'not a run');
  fs.writeFileSync(path.join(dir, 'log'), `2026-01-02T13:00:00Z ticket #9: run 1 of 3 starting; transcript ${dir}/runs/${run}.jsonl\n`);
  fs.writeFileSync(path.join(dir, 'lock'), '');
  const lock = fs.statSync(path.join(dir, 'lock'), {bigint: true});
  const {major, minor} = deviceNumbers(lock.dev);
  // A fake /proc: flock(1) took the lock as pid 4243 and exited; the runner (pid 4242) keeps it open as fd 9.
  const proc = path.join(dir, 'proc');
  fs.mkdirSync(path.join(proc, '4242', 'fd'), {recursive: true});
  fs.writeFileSync(path.join(proc, 'locks'), `1: FLOCK  ADVISORY  WRITE 4243 ${major.toString(16)}:${minor.toString(16).padStart(2, '0')}:${lock.ino} 0 EOF\n`);
  fs.writeFileSync(path.join(proc, 'stat'), `cpu  1 2 3\nbtime ${Date.parse('2026-01-01T00:00:00Z') / 1000}\nprocesses 9\n`);
  fs.symlinkSync(path.join(dir, 'lock'), path.join(proc, '4242', 'fd', '9'));
  startHolder(dir, '2026-01-02T12:59:58Z');
  fs.writeFileSync(path.join(dir, 'issues.json'), JSON.stringify([
    {number: 9, state: 'OPEN', body: '', labels: []},
    {number: 10, state: 'OPEN', body: '', labels: [{name: 'needs-owner'}]},
    {number: 11, state: 'CLOSED', body: '', labels: []},
  ]));
  fs.writeFileSync(path.join(dir, 'prs.json'), '[]');
  return {dir, run};
}

/**
 * Sets when the fake runner process that holds the lock started.
 * @param {string} dir
 * @param {string} time
 */
function startHolder(dir, time) {
  const ticks = (Date.parse(time) - Date.parse('2026-01-01T00:00:00Z')) / 10;
  const fields = ['S', ...Array(18).fill('0'), String(ticks), '0'];
  fs.writeFileSync(path.join(dir, 'proc', '4242', 'stat'), `4242 (ticket runner) ${fields.join(' ')}\n`);
}

/** Releases the lock in the fake /proc. */
const release = (/** @type {string} */ dir) => fs.writeFileSync(path.join(dir, 'proc', 'locks'), '');

/** @typedef {(url: string, method?: string, host?: string) => Promise<{status: number, body: string}>} Get */
/** @typedef {import('./state.mjs').Commands} Commands */

/** Commands whose gh is offline and whose plan names ticket 10. */
const offline = () => ({
  titles: async () => ({value: {issues: {ok: /** @type {const} */ (false), error: 'gh: offline'}, prs: {ok: /** @type {const} */ (false), error: 'gh: offline'}}, at: Date.now()}),
  plan: async () => ({value: {ok: /** @type {const} */ (true), stdout: 'ticket 10\n'}, at: Date.now()}),
});

/**
 * Starts the handler for the given projects on a free loopback port; `get` sends the listen address as Host unless
 * given another. Each readable project's commands are offline() with its overrides.
 * @param {{sharedDir: string, procRoot: string, projects: import('./config.mjs').Project[]}} all
 * @param {(get: Get) => Promise<void>} use
 * @param {Record<string, Partial<Commands>>} [overrides] by project name
 * @param {string[]} [allowedHosts]
 */
async function withMachine(all, use, overrides = {}, allowedHosts = []) {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const config = {host: '127.0.0.1', port: address.port, allowedHosts, runner: 'ticket-runner', gh: 'gh', ...all};
  const commands = new Map(all.projects.map(project => [project.name, {...offline(), ...overrides[project.name]}]));
  server.on('request', handler(config, commands));
  try {
    await use((url, method = 'GET', host = `127.0.0.1:${address.port}`) => new Promise((resolve, reject) => {
      // fetch cannot set Host, so this goes through http.request.
      const request = http.request({host: '127.0.0.1', port: address.port, path: url, method, headers: {Host: host}}, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({status: response.statusCode ?? 0, body}));
      });
      request.on('error', reject);
      request.end();
    }));
  } finally {
    server.close();
  }
}

/**
 * A readable project of repository o/<name> with its state in `dir`.
 * @param {string} name
 * @param {string} dir
 * @returns {import('./config.mjs').Project}
 */
const project = (name, dir) => ({name, ok: true, repo: name === 'demo' ? 'o/r' : `o/${name}`, stateDir: dir, env: {}});

/**
 * withMachine for one project, demo (repository o/r), with its state in `dir`, its fake /proc and a shared directory with no
 * brakes in it.
 * @param {string} dir
 * @param {(get: Get) => Promise<void>} use
 * @param {Partial<Commands>} [overrides]
 * @param {string[]} [allowedHosts]
 */
const withServer = (dir, use, overrides = {}, allowedHosts = []) =>
  withMachine({sharedDir: path.join(dir, 'shared'), procRoot: path.join(dir, 'proc'), projects: [project('demo', dir)]}, use, {demo: overrides}, allowedHosts);

/** A plan command that counts its calls. */
function countingPlan() {
  const counter = {calls: 0};
  const plan = async () => { counter.calls++; return {value: {ok: /** @type {const} */ (true), stdout: 'ticket 10\n'}, at: Date.now()}; };
  return {counter, plan};
}

test('the status page shows the held run, the queue from the files, and degrades when gh fails', async t => {
  const {dir, run} = stateDir(t);
  await withServer(dir, async get => {
    const page = await get('/');
    assert.equal(page.status, 200);
    assert.match(page.body, /<span class="good">Running<\/span> ticket #9,\s+attempt 1 of 3/);
    assert.ok(page.body.includes(`href="run/demo/${run}"`));
    assert.ok(page.body.includes('<h2 class="project">demo</h2>'), 'the one project is named');
    assert.ok(page.body.includes('http-equiv="refresh"'));
    assert.ok(page.body.includes('<span class="label brake">needs-owner</span>'));
    assert.ok(page.body.includes('gh failed, so titles may be missing'));
    assert.ok(!page.body.includes('Issue #11'));
  });
});

test('while the runner holds its lock the plan is not asked for, so it cannot collide with the run', async t => {
  // --plan rewrites issues.json and prs.json and fetches the main checkout; during a run it only names the running ticket.
  const {dir} = stateDir(t);
  const {counter, plan} = countingPlan();
  await withServer(dir, async get => {
    const page = await get('/');
    assert.ok(page.body.includes('Next action: decided after the current run.'));
    assert.ok(!page.body.includes('<code>ticket 10</code>'));
    assert.equal(counter.calls, 0);
  }, {plan});
});

test('with gh failing the page does not claim there is no stop-agents label', async t => {
  // The fallback files can predate a stop-agents label, so its absence there proves nothing.
  const {dir} = stateDir(t);
  release(dir);
  await withServer(dir, async get => {
    const page = await get('/');
    assert.ok(page.body.includes('stop-agents unknown: gh failed'));
    assert.ok(!page.body.includes('No brakes'));
  });
});

test('a stop-agents label gh reports pauses the page even while the runner\'s files are fresh and unlabelled', async t => {
  // The runner exits on stop-agents before rewriting issues.json, so the fresh file still holds pre-brake labels.
  const {dir} = stateDir(t);
  let plans = 0;
  await withServer(dir, async get => {
    const page = await get('/');
    assert.match(page.body, /Paused: stop-agents on #9/);
    assert.ok(page.body.includes('<span class="label brake">stop-agents</span>'));
    assert.ok(page.body.includes('Next action: none while paused.'));
    assert.equal(plans, 0);
  }, {
    titles: async () => ({value: {
      issues: ok([{number: 9, title: 'Nine', labels: [{name: 'stop-agents'}]}, {number: 10, title: 'Ten', labels: [{name: 'needs-owner'}]}]),
      prs: ok([]),
    }, at: Date.now()}),
    plan: async () => { plans++; return {value: {ok: /** @type {const} */ (true), stdout: 'ticket 10\n'}, at: Date.now()}; },
  });
});

test('a Stop-Agents label in any case pauses the page, and brake labels in any case get the brake badge', async t => {
  // GitHub matches label names in any case, and so does the runner.
  const {dir} = stateDir(t);
  await withServer(dir, async get => {
    const page = await get('/');
    assert.match(page.body, /Paused: stop-agents on #9/);
    assert.ok(page.body.includes('<span class="label brake">Stop-Agents</span>'));
    assert.ok(page.body.includes('<span class="label brake">Needs-Owner</span>'));
    assert.ok(page.body.includes('<span class="label brake">HOLD</span>'));
    assert.ok(page.body.includes('Next action: none while paused.'));
  }, {
    titles: async () => ({value: {
      issues: ok([{number: 9, title: 'Nine', labels: [{name: 'Stop-Agents'}]}, {number: 10, title: 'Ten', labels: [{name: 'Needs-Owner'}]}]),
      prs: ok([{number: 12, title: 'Twelve', labels: [{name: 'HOLD'}]}]),
    }, at: Date.now()}),
  });
});

test('a held lock with an unended start older than the lock holder is busy, not that old run', async t => {
  // A killed run leaves a start line with no end; the runner takes its lock on every timer start before logging.
  const {dir} = stateDir(t);
  startHolder(dir, '2026-01-05T08:00:00Z');
  await withServer(dir, async get => {
    const page = await get('/');
    assert.ok(page.body.includes('<span class="good">Busy</span>: the runner holds its lock and has not started a session yet.'));
    assert.ok(!page.body.includes('Running</span>'));
    assert.ok(page.body.includes('no end recorded'));
  });
});

test('without the holder\'s start time, or without the lock table, only a start within 6 h counts as running', t => {
  const {dir, run} = stateDir(t);
  const config = {stateDir: dir, procRoot: path.join(dir, 'proc')};
  fs.rmSync(path.join(dir, 'proc', '4242'), {recursive: true});
  assert.equal(readRuns(config, Date.parse('2026-01-02T18:59:00Z')).activeName, run);
  assert.equal(readRuns(config, Date.parse('2026-01-02T19:01:00Z')).active, null);
  const unreadable = {...config, procRoot: path.join(dir, 'missing')};
  assert.equal(readRuns(unreadable, Date.parse('2026-01-02T18:59:00Z')).held, null);
  assert.equal(readRuns(unreadable, Date.parse('2026-01-02T18:59:00Z')).activeName, run);
  assert.equal(readRuns(unreadable, Date.parse('2026-01-02T19:01:00Z')).active, null);
});

test('the latest start with no end is the fallback active run; an earlier killed run is not', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triphammer-status-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const lines = fs.readFileSync(new URL('./test-fixtures/sample-runner-log.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);
  // No lock table, so a start within the runner's 6 h limit counts; both the 10:00 and the 13:00 start are within it.
  const config = {stateDir: dir, procRoot: path.join(dir, 'missing')};
  const nowMs = Date.parse('2026-01-02T13:30:00Z');
  fs.writeFileSync(path.join(dir, 'log'), `${lines.join('\n')}\n`);
  assert.equal(readRuns(config, nowMs).active?.start.number, 9);
  fs.writeFileSync(path.join(dir, 'log'), `${lines.slice(0, 3).join('\n')}\n`);
  assert.equal(readRuns(config, nowMs).active, null);
});

test('a released lock means idle even with an unended start line', async t => {
  const {dir} = stateDir(t);
  release(dir);
  const {counter, plan} = countingPlan();
  await withServer(dir, async get => {
    const page = await get('/');
    assert.ok(page.body.includes('Idle: no run in progress.'));
    assert.ok(page.body.includes('no end recorded'));
    assert.ok(!page.body.includes('http-equiv="refresh"'));
    assert.ok(page.body.includes('<code>ticket 10</code>'));
    assert.equal(counter.calls, 1);
  }, {plan});
});

test('with gh answering and no brake the page says there are none', async t => {
  const {dir} = stateDir(t);
  release(dir);
  await withServer(dir, async get => {
    const page = await get('/');
    assert.ok(page.body.includes('No brakes: no stop file, backoff or stop-agents label.'));
  }, {titles: async () => ({value: {issues: ok([{number: 9, title: 'Nine', labels: []}]), prs: ok([])}, at: Date.now()})});
});

test('the transcript view escapes content and 404s anything but an existing run name', async t => {
  const {dir, run} = stateDir(t);
  assert.equal(listRuns(path.join(dir, 'runs')).length, 1);
  await withServer(dir, async get => {
    const page = await get(`/run/demo/${run}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('&#60;b&#62;hi&#60;/b&#62;'));
    assert.ok(page.body.includes('http-equiv="refresh"'));
    for (const bad of [`/run/${run}`, '/run/demo/..%2Flog', '/run/demo/../log', '/run/..%2Flog', '/run/demo/20260102T130000Z-ticket-8',
      `/run/demo/${run}.jsonl`, '/run/demo/notes', `/run/demo/${run}/x`, `/run/other/${run}`, '/log']) {
      assert.equal((await get(bad)).status, 404, bad);
    }
    assert.equal((await get('/', 'POST')).status, 405);
    assert.equal((await get('/', 'HEAD')).status, 200);
  });
});

test('only requests addressed to the listen address or an allowed name are served; others get 421', async t => {
  // A page that rebinds its own name to this address sends its own name as Host, so it is refused.
  const {dir} = stateDir(t);
  release(dir);
  await withServer(dir, async get => {
    const foreign = await get('/', 'GET', 'evil.example');
    assert.equal(foreign.status, 421);
    assert.ok(!foreign.body.includes('ticket #9'));
    assert.equal((await get('/run/demo/20260102T130000Z-ticket-9', 'GET', 'evil.example:80')).status, 421);
    assert.equal((await get('/', 'GET')).status, 200);
    assert.equal((await get('/', 'GET', 'status.example')).status, 200);
    assert.equal((await get('/', 'GET', 'STATUS.Example:443')).status, 200);
    assert.equal((await get('/', 'GET', 'box.ts.net:8443')).status, 200);
    assert.equal((await get('/', 'GET', 'box.ts.net')).status, 421);
  }, {}, ['status.example', 'box.ts.net:8443']);
});

test('host matching: the listen port is required, loopback names count for loopback and wildcard listeners', () => {
  const at = (/** @type {string} */ host, /** @type {string[]} */ allowedHosts = []) => ({host, port: 8787, allowedHosts});
  const yes = (/** @type {string | undefined} */ header, /** @type {ReturnType<typeof at>} */ config) => assert.equal(isAllowedHost(header, config), true, header);
  const no = (/** @type {string | undefined} */ header, /** @type {ReturnType<typeof at>} */ config) => assert.equal(isAllowedHost(header, config), false, header);
  for (const header of ['127.0.0.1:8787', 'LOCALHOST:8787', '[::1]:8787']) yes(header, at('127.0.0.1'));
  for (const header of ['127.0.0.1', '127.0.0.1:8788', 'localhost', undefined, '', ':8787', 'evil.example:8787']) no(header, at('127.0.0.1'));
  yes('localhost:8787', at('0.0.0.0'));
  no('0.0.0.0:8787', at('0.0.0.0'));
  no('192.168.1.5:8787', at('0.0.0.0'));
  yes('192.168.1.5:8787', at('0.0.0.0', ['192.168.1.5']));
  yes('[::1]:8787', at('::'));
  yes('[::1]:8787', at('::1'));
  yes('192.168.1.5:8787', at('192.168.1.5'));
  no('localhost:8787', at('192.168.1.5'));
  no('status.example.evil:8787', at('127.0.0.1', ['status.example']));
});

/**
 * A fixture's gh answers: issues, pull requests and label events as `gh` returns them.
 * @param {string} name
 */
function waitingGh(name = 'waiting-gh.json') {
  const fixture = JSON.parse(fs.readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url), 'utf8'));
  return {fixture, titles: async () => ({value: {issues: ok(fixture.issues), prs: ok(fixture.prs), labelEvents: ok(fixture.labelEvents)}, at: Date.now()})};
}

/**
 * The "Waiting on you" section of a status page.
 * @param {string} body
 */
function waitingSection(body) {
  const match = /<h2>Waiting on you(?: \(\d+\))?<\/h2>([\s\S]*?)<h2 class="project">/.exec(body);
  assert.ok(match, 'the page has a Waiting on you section before the projects');
  return match[1];
}

/** @param {string} section */
const rowHeads = section => [...section.matchAll(/<li><span class="project">[^<]*<\/span> (?:<a href="([^"]+)">|<span class="bad">(Brake))/g)].map(match => match[1] ?? match[2]);

test('Waiting on you lists brakes first, then every kind of row oldest waiting first, with links and ages', async t => {
  const {dir} = stateDir(t);
  release(dir);
  await withServer(dir, async get => {
    const section = waitingSection((await get('/')).body);
    assert.deepEqual(rowHeads(section), [
      'https://github.com/o/r/issues/23', // stop-agents: a brake, first although its label is the newest
      'https://github.com/o/r/pull/31', // green, not armed: checks settled 2026-01-02
      'https://github.com/o/r/issues/21', // needs-owner re-added 2026-01-03, opened 2025-12-01
      'https://github.com/o/r/pull/30', // escalate with needs-owner since 2026-01-04
      'https://github.com/o/r/issues/20', // needs-owner since 2026-01-05
      'https://github.com/o/r/pull/32', // hold since 2026-01-06
    ]);
    assert.ok(section.includes('labelled stop-agents: the agents are paused'));
    assert.ok(section.includes('Issue #20</a> Pick a store'));
    assert.ok(section.includes('<br>Pick store A or store B.</li>'), 'only the first sentence of the decision');
    assert.ok(section.includes('Issue #21</a> Title &#60;b&#62;21&#60;/b&#62;'), 'titles are escaped');
    assert.ok(section.includes('<br>Title &#60;b&#62;21&#60;/b&#62;</li>'), 'without a decision line the title is the note');
    assert.ok(section.includes('green, not armed: arm with <code>gh pr merge 31 --auto --squash</code>'));
    assert.ok(section.includes('labelled needs-owner<br>escalate, no owner approval: <a href="https://github.com/o/r/actions/runs/30?a=1&#38;b=&#34;x&#34;">reasons in the risk-tier run</a> · Escalate: waiting for @o to approve 3000000 (Files changed, Review changes, Approve)</li>'),
      'the escalate note links to the risk-tier run that holds the reasons, escaped');
    assert.ok(section.includes('PR #32</a> Held fix <span class="muted">'));
    assert.ok(!/arm with <code>gh pr merge 32 /.test(section), 'a held pull request is not asked to be armed');
    for (const hidden of ['issues/22', 'pull/33', 'pull/34', 'pull/35', 'pull/36']) assert.ok(!section.includes(hidden), hidden);
    assert.match(section, /<li><span class="project">demo<\/span> <a href="https:\/\/github.com\/o\/r\/issues\/20">Issue #20<\/a> Pick a store <span class="muted">· \d+ d<\/span>/);
    assert.ok(!section.includes('Nothing is waiting on you'));
    assert.ok(!/<(button|form|input)\b/.test(section));
  }, {titles: waitingGh().titles});
});

test('Waiting on you reads the hold, needs-owner and stop-agents labels and their label events in any case', async t => {
  // The items' labels are capitalized and the events' upper case, so each is compared without regard to case.
  const {dir} = stateDir(t);
  release(dir);
  const {fixture} = waitingGh();
  const capitalized = (/** @type {string} */ name) => name.replace(/(^|-)(\w)/g, (_, dash, letter) => dash + letter.toUpperCase());
  for (const item of [...fixture.issues, ...fixture.prs]) item.labels = item.labels.map((/** @type {any} */ label) => ({name: capitalized(label.name)}));
  const {issues, pullRequests} = fixture.labelEvents.data.repository;
  for (const node of [...issues.nodes, ...pullRequests.nodes]) {
    for (const event of node.timelineItems.nodes) event.label.name = event.label.name.toUpperCase();
  }
  await withServer(dir, async get => {
    const section = waitingSection((await get('/')).body);
    // The same order as with lower-case labels, which needs the label times: #21 was opened before every other item.
    assert.deepEqual(rowHeads(section), [
      'https://github.com/o/r/issues/23',
      'https://github.com/o/r/pull/31',
      'https://github.com/o/r/issues/21',
      'https://github.com/o/r/pull/30',
      'https://github.com/o/r/issues/20',
      'https://github.com/o/r/pull/32',
    ]);
    assert.ok(section.includes('labelled stop-agents: the agents are paused'));
    assert.ok(section.includes('labelled needs-owner<br>escalate, no owner approval: '));
    assert.ok(section.includes('PR #32</a> Held fix <span class="muted">'));
    assert.ok(!/arm with <code>gh pr merge 32 /.test(section), 'a Hold pull request is not asked to be armed');
  }, {titles: async () => ({value: {issues: ok(fixture.issues), prs: ok(fixture.prs), labelEvents: ok(fixture.labelEvents)}, at: Date.now()})});
});

test('a pull request waits for approval exactly when the risk-tier workflow posted an escalate status on its head', async t => {
  // 40 and 41 change a test file and 42 is a rename into src/ out of Triphammer, which a tier worked out from gh's file
  // list would get wrong; 40 is still being classified and 43 has no status yet, so neither is called escalate.
  const {dir} = stateDir(t);
  release(dir);
  await withServer(dir, async get => {
    const section = waitingSection((await get('/')).body);
    assert.deepEqual(rowHeads(section), ['https://github.com/o/r/pull/42']);
    assert.ok(section.includes('<br>escalate, no owner approval: reasons in the risk-tier run · Escalate: waiting for @o to approve 4200000 (Files changed, Review changes, Approve)</li>'),
      'without a target URL the pointer to the run is plain text');
  }, {titles: waitingGh('waiting-tiers-gh.json').titles});
});

test('an escalate note links only to http(s) pages on github.com', async t => {
  const {dir} = stateDir(t);
  release(dir);
  const {fixture} = waitingGh('waiting-tiers-gh.json');
  const status = fixture.labelEvents.data.repository.approvals.nodes.find((/** @type {any} */ node) => node.number === 42).commits.nodes[0].commit.status.context;
  for (const targetUrl of ['javascript:alert(1)', 'https://github.com.evil.example/o/r/actions/runs/1', 'ftp://github.com/o/r', 'https://u:p@github.com/o/r', 'not a url', 42]) {
    status.targetUrl = targetUrl;
    const labelEvents = ok(fixture.labelEvents);
    await withServer(dir, async get => {
      const section = waitingSection((await get('/')).body);
      assert.ok(section.includes('<br>escalate, no owner approval: reasons in the risk-tier run · Escalate: waiting'), String(targetUrl));
      assert.deepEqual([...section.matchAll(/href="([^"]+)"/g)].map(match => match[1]), ['https://github.com/o/r/pull/42'], String(targetUrl));
    }, {titles: async () => ({value: {issues: ok(fixture.issues), prs: ok(fixture.prs), labelEvents}, at: Date.now()})});
  }
});

test('an unarmed pull request behind its base is green, not armed, exactly when every latest check on its head passed', async t => {
  // merge-when-ready only updates armed pull requests, so an unarmed green one goes BEHIND as soon as main moves.
  const {dir} = stateDir(t);
  release(dir);
  const run = (/** @type {string} */ conclusion, /** @type {string} */ startedAt) =>
    ({__typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion, startedAt, completedAt: startedAt});
  const approval = (/** @type {string} */ state) => ({__typename: 'StatusContext', context: 'owner-approval', state, startedAt: '2026-01-01T13:00:00Z'});
  const pr = (/** @type {number} */ number, /** @type {unknown[]} */ statusCheckRollup) => ({number, title: `PR ${number}`, createdAt: '2026-01-01T00:00:00Z',
    isDraft: false, baseRefName: 'main', labels: [], autoMergeRequest: null, mergeStateStatus: 'BEHIND', statusCheckRollup});
  const prs = [
    pr(50, [run('SUCCESS', '2026-01-02T00:00:00Z'), approval('SUCCESS')]), // green
    pr(51, [run('FAILURE', '2026-01-02T00:00:00Z'), approval('SUCCESS')]), // a failed check
    pr(52, [run('FAILURE', '2026-01-02T00:00:00Z'), run('SUCCESS', '2026-01-03T00:00:00Z'), approval('SUCCESS')]), // a rerun passed
    pr(53, [run('SUCCESS', '2026-01-02T00:00:00Z'), {__typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: '', startedAt: '2026-01-02T00:00:00Z'}]), // in flight
    pr(54, [run('SUCCESS', '2026-01-02T00:00:00Z'), approval('PENDING')]), // escalated, not approved
    pr(55, []), // no checks reported
  ];
  const labelEvents = ok({data: {repository: {defaultBranchRef: {name: 'main'}, issues: {nodes: []}, pullRequests: {nodes: []}, approvals: {nodes: [
    {number: 54, commits: {nodes: [{commit: {status: {context: {state: 'PENDING', description: 'Escalate: waiting for @o to approve 5400000'}}}}]}},
  ]}}}});
  await withServer(dir, async get => {
    const section = waitingSection((await get('/')).body);
    assert.deepEqual(rowHeads(section).sort(), ['https://github.com/o/r/pull/50', 'https://github.com/o/r/pull/52', 'https://github.com/o/r/pull/54']);
    for (const number of [50, 52]) assert.ok(section.includes(`green, not armed: arm with <code>gh pr merge ${number} --auto --squash</code>`), String(number));
    assert.ok(section.includes('escalate, no owner approval: reasons in the risk-tier run · Escalate: waiting for @o to approve 5400000'), 'an escalated head behind its base still asks for approval');
    assert.ok(!section.includes('gh pr merge 54 '), 'an escalated head is not called green while owner-approval is pending');
  }, {titles: async () => ({value: {issues: ok([]), prs: ok(prs), labelEvents}, at: Date.now()})});
});

test('a stop file and a backoff in force come first in Waiting on you', async t => {
  const {dir} = stateDir(t);
  release(dir);
  fs.writeFileSync(path.join(dir, 'stop'), '');
  fs.writeFileSync(path.join(dir, 'backoff'), String(Math.floor(Date.now() / 1000) + 3600));
  await withServer(dir, async get => {
    const heads = rowHeads(waitingSection((await get('/')).body));
    assert.deepEqual(heads.slice(0, 3).sort(), ['Brake', 'Brake', 'https://github.com/o/r/issues/23']);
    assert.equal(heads[3], 'https://github.com/o/r/pull/31');
    const section = waitingSection((await get('/')).body);
    assert.ok(section.includes('the stop file is present'));
    assert.ok(section.includes('backoff until '));
  }, {titles: waitingGh().titles});
});

test('without label events, labelled items count from when they were opened, and the page says so', async t => {
  const {dir} = stateDir(t);
  release(dir);
  const {fixture} = waitingGh();
  await withServer(dir, async get => {
    const section = waitingSection((await get('/')).body);
    assert.ok(section.includes('<span class="project">demo</span>: label times are unavailable'));
    assert.ok(section.includes('pull requests waiting for the owner\'s approval are not listed'));
    assert.ok(!section.includes('escalate'), 'without the statuses no pull request is called escalate');
    // #21 was opened 2025-12-01, before every other item.
    assert.equal(rowHeads(section)[1], 'https://github.com/o/r/issues/21');
  }, {titles: async () => ({value: {issues: ok(fixture.issues), prs: ok(fixture.prs), labelEvents: {ok: /** @type {const} */ (false), error: 'gh: no'}}, at: Date.now()})});
});

test('an empty queue shows exactly one line saying nothing is waiting', async t => {
  const {dir} = stateDir(t);
  release(dir);
  await withServer(dir, async get => {
    const section = waitingSection((await get('/')).body);
    assert.equal(section.trim(), '<p>Nothing is waiting on you</p>');
  }, {titles: async () => ({value: {issues: ok([{number: 9, title: 'Nine', labels: [], body: ''}]), prs: ok([]), labelEvents: ok({data: {repository: {issues: {nodes: []}, pullRequests: {nodes: []}}}})}, at: Date.now()})});
});

test('with gh failing Waiting on you does not claim the queue is empty', async t => {
  // The runner's files can predate a label, so they cannot prove nothing is waiting.
  const {dir} = stateDir(t);
  release(dir);
  await withServer(dir, async get => {
    const section = waitingSection((await get('/')).body);
    assert.ok(section.includes('issues and pull requests waiting on you are unknown'));
    assert.ok(!section.includes('Nothing is waiting on you'));
    assert.ok(!section.includes('issues/10'), 'a needs-owner label from the stale files is not listed');
  });
});

/**
 * Each project's section of a status page, by project name.
 * @param {string} body
 */
function projectSections(body) {
  return Object.fromEntries([...body.matchAll(/<h2 class="project">([^<]*)<\/h2>([\s\S]*?)(?=<h2 class="project">|<\/body>)/g)].map(match => [match[1], match[2]]));
}

/**
 * The project label and the link or brake of each "Waiting on you" row.
 * @param {string} section
 */
const labelledRows = section => [...section.matchAll(/<li><span class="project">([^<]*)<\/span> (?:<a href="([^"]+)">|<span class="bad">(Brake))/g)]
  .map(match => [match[1], match[2] ?? match[3]]);

/** gh answers for a project with one needs-owner issue, #5. */
const oneDecision = () => ({value: {
  issues: ok([{number: 5, title: 'Beta decision', labels: [{name: 'needs-owner'}], body: '**Decision for the owner:** Pick beta.', createdAt: '2026-01-01T00:00:00Z'}]),
  prs: ok([]),
  labelEvents: ok({data: {repository: {defaultBranchRef: {name: 'main'}, issues: {nodes: []}, pullRequests: {nodes: []}, approvals: {nodes: []}}}}),
}, at: Date.now()});

/**
 * Two projects, alpha and beta, each with a state directory like stateDir()'s; the fake /proc is alpha's, so only alpha
 * holds its lock.
 */
function twoProjects(t) {
  const alpha = stateDir(t);
  const beta = stateDir(t);
  return {alpha, beta, all: {sharedDir: path.join(alpha.dir, 'shared'), procRoot: path.join(alpha.dir, 'proc'), projects: [project('alpha', alpha.dir), project('beta', beta.dir)]}};
}

test('with two projects Waiting on you is one list with rows from both, each naming its project, and counts exactly its rows', async t => {
  const {all} = twoProjects(t);
  await withMachine(all, async get => {
    const body = (await get('/')).body;
    const section = waitingSection(body);
    const rows = labelledRows(section);
    assert.deepEqual(rows, [
      ['alpha', 'https://github.com/o/alpha/issues/23'],
      ['beta', 'https://github.com/o/beta/issues/5'], // opened 2026-01-01, before every alpha row but the brake
      ['alpha', 'https://github.com/o/alpha/pull/31'],
      ['alpha', 'https://github.com/o/alpha/issues/21'],
      ['alpha', 'https://github.com/o/alpha/pull/30'],
      ['alpha', 'https://github.com/o/alpha/issues/20'],
      ['alpha', 'https://github.com/o/alpha/pull/32'],
    ]);
    assert.equal((section.match(/<li>/g) ?? []).length, rows.length, 'every row names its project');
    assert.ok(body.includes(`<h2>Waiting on you (${rows.length})</h2>`), 'the count is the rows shown');
    assert.deepEqual(Object.keys(projectSections(body)), ['alpha', 'beta']);
    assert.ok(section.includes('<br>Pick beta.</li>'));
  }, {alpha: {titles: waitingGh().titles}, beta: {titles: async () => oneDecision()}});
});

test('a project whose state directory or config cannot be read shows its error in its own section and the others render', async t => {
  const {alpha, all} = twoProjects(t);
  const missing = path.join(alpha.dir, 'no-such-state');
  const file = path.join(alpha.dir, 'log');
  all.projects = [all.projects[0], project('beta', missing), project('delta', file),
    {name: 'gamma', ok: false, error: '/cfg/gamma.conf does not set STATE_DIR'}];
  await withMachine(all, async get => {
    const page = await get('/');
    assert.equal(page.status, 200);
    const sections = projectSections(page.body);
    assert.deepEqual(Object.keys(sections), ['alpha', 'beta', 'delta', 'gamma']);
    assert.match(sections.alpha, /<span class="good">Running<\/span> ticket #9/);
    assert.ok(sections.alpha.includes('href="run/alpha/20260102T130000Z-ticket-9"'));
    assert.ok(sections.beta.includes(`cannot read the state directory ${missing}: ENOENT`), sections.beta);
    assert.ok(sections.delta.includes(`cannot read the state directory ${file}: ENOTDIR`), sections.delta);
    assert.ok(sections.gamma.includes('/cfg/gamma.conf does not set STATE_DIR'));
    for (const name of ['beta', 'delta', 'gamma']) assert.ok(!sections[name].includes('<h3>'), name);
    const section = waitingSection(page.body);
    for (const name of ['beta', 'delta', 'gamma']) {
      assert.ok(section.includes(`<span class="project">${name}</span>: it cannot be read, so what waits on you there is unknown`), name);
    }
    assert.deepEqual(labelledRows(section).map(row => row[0]), ['alpha']);
    assert.ok(!section.includes('Nothing is waiting on you'));
  }, {alpha: {titles: async () => oneDecision()}});
});

test('gh failing for one project is said in its own area only, and the other project\'s rows are still listed', async t => {
  const {all} = twoProjects(t);
  await withMachine(all, async get => {
    const body = (await get('/')).body;
    const section = waitingSection(body);
    assert.ok(section.includes('<span class="project">alpha</span>: gh failed, so issues and pull requests waiting on you are unknown'));
    assert.ok(!section.includes('<span class="project">beta</span>: gh failed'));
    assert.deepEqual(labelledRows(section), [['beta', 'https://github.com/o/beta/issues/5']]);
    assert.ok(!section.includes('Nothing is waiting on you'));
    const sections = projectSections(body);
    assert.ok(sections.alpha.includes('gh failed, so titles may be missing'));
    assert.ok(!sections.beta.includes('gh failed'));
  }, {beta: {titles: async () => oneDecision()}});
});

test('Triphammer\'s stop file and backoff are listed once, first, then each project\'s own brakes, and pause every project', async t => {
  const {alpha, beta, all} = twoProjects(t);
  fs.mkdirSync(all.sharedDir);
  fs.writeFileSync(path.join(all.sharedDir, 'stop'), '');
  fs.writeFileSync(path.join(all.sharedDir, 'backoff'), String(Math.floor(Date.now() / 1000) + 3600));
  fs.writeFileSync(path.join(beta.dir, 'stop'), '');
  release(alpha.dir);
  let plans = 0;
  const plan = async () => { plans++; return {value: {ok: /** @type {const} */ (true), stdout: 'ticket 10\n'}, at: Date.now()}; };
  await withMachine(all, async get => {
    const body = (await get('/')).body;
    const section = waitingSection(body);
    assert.deepEqual(labelledRows(section).slice(0, 3), [['all projects', 'Brake'], ['all projects', 'Brake'], ['beta', 'Brake']]);
    assert.equal(section.split('Triphammer&#39;s stop file is present: every project&#39;s runner and merge-when-ready are paused').length - 1, 1);
    assert.equal(section.split(': every project is paused').length - 1, 1);
    assert.ok(section.includes('<span class="project">beta</span> <span class="bad">Brake</span> <span class="muted">· 0 min</span><br>the stop file is present'));
    const sections = projectSections(body);
    assert.match(sections.alpha, /Paused: every project is paused \(see Waiting on you\)\./);
    assert.match(sections.beta, /Paused: every project is paused \(see Waiting on you\); the stop file is present\./);
    for (const name of ['alpha', 'beta']) assert.ok(sections[name].includes('Next action: none while paused.'), name);
    assert.equal(plans, 0);
  }, {alpha: {plan}, beta: {plan}});
});

test('transcript links carry the project and resolve only within that project\'s state directory', async t => {
  const {alpha, beta, all} = twoProjects(t);
  fs.writeFileSync(path.join(beta.dir, 'runs', `${beta.run}.jsonl`), '{"type":"assistant","message":{"content":[{"type":"text","text":"beta says hi"}]}}\n');
  const betaOnly = '20260103T100000Z-repair-4';
  fs.writeFileSync(path.join(beta.dir, 'runs', `${betaOnly}.jsonl`), '');
  all.projects.push({name: 'gamma', ok: false, error: 'unreadable config'});
  await withMachine(all, async get => {
    const sections = projectSections((await get('/')).body);
    assert.ok(sections.alpha.includes(`href="run/alpha/${alpha.run}"`));
    assert.ok(sections.beta.includes(`href="run/beta/${beta.run}"`) && sections.beta.includes(`href="run/beta/${betaOnly}"`));
    const alphaPage = await get(`/run/alpha/${alpha.run}`);
    assert.equal(alphaPage.status, 200);
    assert.ok(alphaPage.body.includes('&#60;b&#62;hi&#60;/b&#62;') && !alphaPage.body.includes('beta says hi'));
    assert.ok(alphaPage.body.includes('<a href="../../">&larr; Triphammer status</a>'));
    assert.ok(alphaPage.body.includes('<h1>alpha: ticket #9</h1>'));
    const betaPage = await get(`/run/beta/${beta.run}`);
    assert.ok(betaPage.body.includes('beta says hi') && !betaPage.body.includes('&#60;b&#62;hi'));
    assert.equal((await get(`/run/beta/${betaOnly}`)).status, 200);
    const betaRuns = encodeURIComponent(path.relative(alpha.dir, path.join(beta.dir, 'runs')));
    for (const bad of [
      `/run/alpha/${betaOnly}`, `/run/gamma/${alpha.run}`, `/run/nope/${alpha.run}`, `/run/${alpha.run}`,
      `/run/alpha%2F..%2Fbeta/${betaOnly}`, `/run/alpha/..%2F${betaRuns}%2F${betaOnly}`, `/run/alpha/../beta/x`,
      `/run/%61lpha/${alpha.run}`, `/run/alpha/${alpha.run}%2F`,
    ]) {
      assert.equal((await get(bad)).status, 404, bad);
    }
  });
});

test('each project\'s plan runs the runner with that project\'s environment', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triphammer-status-runner-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const runner = path.join(dir, 'ticket-runner');
  fs.writeFileSync(runner, '#!/bin/sh\nprintf "%s %s" "$1" "$TRIPHAMMER_PROJECT"\n', {mode: 0o755});
  const config = {name: 'beta', stateDir: dir, repo: 'o/beta', runner, gh: 'false', env: {PATH: process.env.PATH, TRIPHAMMER_PROJECT: 'beta'}};
  assert.deepEqual((await commandsFor(config).plan()).value, {ok: true, stdout: '--plan beta'});
});

test('the decision is the first sentence after the marker, or none', () => {
  assert.equal(decisionText('x\n**Decision for the owner:** Merge it? Or not.'), 'Merge it?');
  assert.equal(decisionText('**Decision for the owner:**\nUse v2 of the API.\nThen more.'), 'Use v2 of the API.');
  assert.equal(decisionText('**Decision for the owner:** no full stop\n\nNext paragraph.'), 'no full stop');
  assert.equal(decisionText('**Decision for the owner:**\n\nAfter a blank line.'), null);
  assert.equal(decisionText('No marker.'), null);
  assert.equal(decisionText(undefined), null);
});

test('ages read in days, hours or minutes', () => {
  assert.equal(formatAge(3 * 86_400_000 + 5_000), '3 d');
  assert.equal(formatAge(5 * 3_600_000), '5 h');
  assert.equal(formatAge(12 * 60_000), '12 min');
  assert.equal(formatAge(-1), '0 min');
});
