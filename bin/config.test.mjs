import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {here, toolingEnv} from './fixture.mjs';

// A config.sh function with its arguments run against a machine file under a throwaway TRIPHAMMER_PROVISION_ROOT
// holding `text` (none when null).
function machineRun(t, text, ...call) {
  const root = mkdtempSync(join(tmpdir(), 'config-machine-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  if (text !== null) {
    mkdirSync(join(root, 'etc'));
    writeFileSync(join(root, 'etc/triphammer.conf'), text);
  }
  return spawnSync('bash', ['-c', 'source "$1" && shift && "$@"', 'bash', join(here, 'config.sh'), ...call],
    {encoding: 'utf8', env: {...toolingEnv, TRIPHAMMER_PROVISION_ROOT: root}});
}
const machineGet = (t, text, key) => machineRun(t, text, 'machine_get', key);

const machineFile = [
  '# Written by bin/provision: TRIPHAMMER_USER=commented',
  'TRIPHAMMER_REPO=example/triphammer',
  'TRIPHAMMER_USER=first',
  '',
  'TRIPHAMMER_HOME= /home/with space="quoted"=and#more ',
  'TRIPHAMMER_USER=triphammer',
  'TRIPHAMMER_USERNAME=other',
  'TRIPHAMMER_CHECKOUT',
  'TRIPHAMMER_EMPTY=',
  'TRIPHAMMER_LAST=no newline',
].join('\n');

test('machine_get prints the value after the first = of the last line that gives the key, as it stands', t => {
  for (const [key, value] of [
    ['TRIPHAMMER_REPO', 'example/triphammer'],
    ['TRIPHAMMER_USER', 'triphammer'],
    ['TRIPHAMMER_HOME', ' /home/with space="quoted"=and#more '],
    ['TRIPHAMMER_LAST', 'no newline'],
  ]) {
    const result = machineGet(t, machineFile, key);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, value, key);
  }
});

test('machine_get prints nothing for a key the file leaves out, gives empty or names without =, or a missing file', t => {
  for (const [text, key] of [
    [machineFile, 'TRIPHAMMER_DOCKER_SOCKET'],
    [machineFile, 'TRIPHAMMER_EMPTY'],
    [machineFile, 'TRIPHAMMER_CHECKOUT'],
    [machineFile, 'TRIPHAMMER'],
    [null, 'TRIPHAMMER_REPO'],
  ]) {
    const result = machineGet(t, text, key);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '', `${key} in ${text === null ? 'no file' : 'the file'}`);
    assert.equal(result.stderr, '');
  }
});

// Two Docker projects' daemons, a socket key with no project's name, and keys that name no plain absolute path.
const dockerMachine = [
  'TRIPHAMMER_USER=triphammer',
  'TRIPHAMMER_DOCKER_SOCKET=/var/lib/no-project/docker.sock',
  'TRIPHAMMER_DOCKER_USER_EXAMPLE_PROJECT=triphammer-docker-example-project',
  'TRIPHAMMER_DOCKER_SOCKET_EXAMPLE_PROJECT=/var/lib/triphammer-docker-example-project/docker.sock',
  'TRIPHAMMER_DOCKER_SOCKET_OTHER=/var/lib/old/docker.sock',
  'TRIPHAMMER_DOCKER_SOCKET_OTHER=/var/lib/triphammer-docker-other/docker.sock',
  'TRIPHAMMER_DOCKER_SOCKET_RELATIVE=var/lib/x/docker.sock',
  'TRIPHAMMER_DOCKER_SOCKET_DOTS=/var/lib/../x/docker.sock',
  'TRIPHAMMER_DOCKER_SOCKET_SPACE=/var/lib/a b/docker.sock',
].join('\n');

test("rootless_docker_host gives each project its own daemon's socket, and nothing for a project without one", t => {
  for (const [project, host] of [
    ['example-project', 'unix:///var/lib/triphammer-docker-example-project/docker.sock\n'],
    ['other', 'unix:///var/lib/triphammer-docker-other/docker.sock\n'],
    ['unknown', ''], ['relative', ''], ['dots', ''], ['space', ''],
    // Names with no key of their own: EXAMPLE_PROJECT is example-project's alone.
    ['Example-Project', ''], ['example_project', ''], ['example.project', ''], ['-example', ''], ['', ''],
  ]) {
    const result = machineRun(t, dockerMachine, 'rootless_docker_host', project);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, host, project);
  }
  assert.equal(machineRun(t, null, 'rootless_docker_host', 'example-project').stdout, '');
});

test('docker_key maps lower-case names with dashes, and no other name', t => {
  for (const [project, key] of [['example-project', 'EXAMPLE_PROJECT\n'], ['a1', 'A1\n'], ['9x--y', '9X__Y\n']]) {
    const result = machineRun(t, null, 'docker_key', project);
    assert.equal(result.status, 0, project);
    assert.equal(result.stdout, key, project);
  }
  for (const project of ['Example', 'a_b', 'a.b', '-a', '', 'a b']) {
    const result = machineRun(t, null, 'docker_key', project);
    assert.equal(result.status, 1, project);
    assert.equal(result.stdout, '', project);
  }
});

test("rootless_docker_sockets lists each project's daemon the machine file names, each once", t => {
  const result = machineRun(t, dockerMachine, 'rootless_docker_sockets');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, ['/var/lib/triphammer-docker-example-project/docker.sock', '/var/lib/triphammer-docker-other/docker.sock', ''].join('\n'));
  assert.equal(machineRun(t, null, 'rootless_docker_sockets').stdout, '');
});
