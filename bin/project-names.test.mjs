import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {here} from './fixture.mjs';

// Triphammer's files name no project, owner or machine: a project that uses Triphammer describes itself in its own
// .triphammer/project.json and config, and these files use placeholders (<owner>/<repo>, app/<app-login>,
// /srv/<project>) or the example project under test-fixtures/example-project instead.
const repository = join(here, '..');
const files = [
  '.claude-plugin/marketplace.json',
  'plugins/triphammer/hooks/agent-guard.py',
  'plugins/triphammer/hooks/agent-guard-fixture.mjs',
  'plugins/triphammer/hooks/agent-guard-file-tools.test.mjs',
  'plugins/triphammer/hooks/agent-guard-kill.test.mjs',
  'plugins/triphammer/hooks/agent-guard-persistence.test.mjs',
  'plugins/triphammer/hooks/agent-guard-session-writes.test.mjs',
  'plugins/triphammer/hooks/agent-guard-shell-edit.test.mjs',
  'plugins/triphammer/skills/merge-policy/SKILL.md',
  'scripts/risk-tier.test.mjs',
  'scripts/test-pr-contract.sh',
  'status/README.md',
  'status/test-fixtures/waiting-tiers-gh.json',
  'bin/README.md',
  'bin/fake-docker.mjs',
  'bin/provision',
  'bin/provision.test.mjs',
  'bin/provision-lib.sh',
  'bin/provision-project',
  'bin/provision-project.test.mjs',
  'bin/provision-fixture.mjs',
  'bin/triphammer',
  'bin/triphammer.test.mjs',
  'bin/fixture.mjs',
  'bin/security-review.test.mjs',
  'bin/ticket-decide.test.mjs',
  'bin/ticket-runner.test.mjs',
  'systemd/ticket-runner@.service',
];

// The names are compared in lower case without hyphens and underscores, so `my-project` also catches `MyProject` and
// `my_project`.
const folded = text => text.toLowerCase().replace(/[-_]/g, '');

// The project's name comes from its project file; a copy of Triphammer's files has none, and then names nothing to
// look for.
const projectFile = join(repository, '.triphammer/project.json');
const project = existsSync(projectFile) ? JSON.parse(readFileSync(projectFile, 'utf8')).name : null;

// The owner is the first path segment of the origin remote's GitHub URL (https://github.com/<owner>/<repo>.git or
// git@github.com:<owner>/<repo>.git). It is the repository's own record of where it lives, the same in a workstation's
// checkout, a worktree and CI, and needs neither the machine's config nor the network.
function originOwner() {
  const result = spawnSync('git', ['-C', repository, 'remote', 'get-url', 'origin'], {encoding: 'utf8'});
  if (result.status !== 0) return null;
  return /github\.com[/:]([^/]+)\//.exec(result.stdout.trim())?.[1] ?? null;
}

// Lines that must keep a name, each with its reason: (file, the name's kind, a test of the trimmed line).
const exceptions = [
  {file: '.claude-plugin/marketplace.json', kind: 'owner',
    line: (line, root) => line === `"name": ${JSON.stringify(marketplaceOwner(root))}`,
    reason: "the marketplace requires an owner, and owner.name is the account that publishes the plugin"},
];

function marketplaceOwner(root) {
  return JSON.parse(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8')).owner?.name;
}

// Every `file:line: text` of `list` under `root` that contains `name`, apart from the exceptions for its kind.
function mentions(name, kind, root = repository, list = files) {
  const needle = folded(name);
  const found = [];
  for (const file of list) {
    const path = join(root, file);
    assert.ok(existsSync(path), `${file} is gone: update the file list in bin/project-names.test.mjs`);
    readFileSync(path, 'utf8').split('\n').forEach((text, index) => {
      if (!folded(text).includes(needle)) return;
      if (exceptions.some(e => e.file === file && e.kind === kind && e.line(text.trim(), root))) return;
      found.push(`${file}:${index + 1}: ${text.trim()}`);
    });
  }
  return found;
}

const fix = 'use a placeholder (<owner>/<repo>, app/<app-login>, /srv/<project>) or the example project instead, or add '
  + 'an exception with its reason in bin/project-names.test.mjs';

// In Triphammer's own repository the project is Triphammer, whose files name it everywhere; the owner check still runs.
const own = project === 'triphammer';
test("Triphammer's files do not contain the project's name",
  {skip: !project ? 'no .triphammer/project.json' : own ? "this is Triphammer's own repository" : false}, () => {
  const found = mentions(project, 'project');
  assert.deepEqual(found, [], `these lines name the project ${project}; ${fix}:\n${found.join('\n')}`);
});

const owner = project ? originOwner() : null;
test("Triphammer's files do not contain the repository's owner, apart from the marketplace's owner",
  {skip: !project ? 'no .triphammer/project.json' : owner ? false : 'the origin remote is no GitHub repository'}, () => {
    const found = mentions(owner, 'owner');
    assert.deepEqual(found, [], `these lines name the owner ${owner}; ${fix}:\n${found.join('\n')}`);
  });

test('a name is found with its file and line in any case, with or without hyphens, and only the exception keeps one', t => {
  const root = mkdtempSync(join(tmpdir(), 'project-names-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, '.claude-plugin'));
  writeFileSync(join(root, 'a.md'), 'Closes Example-Owner/Example-Project#1\nan example of a project\n'
    + 'the ExampleProject solution\nexample_project.conf\n');
  writeFileSync(join(root, '.claude-plugin/marketplace.json'),
    JSON.stringify({name: 'x', owner: {name: 'Example-Owner'}, plugins: [{name: 'example-owner-tools'}]}, null, 2));
  const list = ['a.md', '.claude-plugin/marketplace.json'];
  assert.deepEqual(mentions('example-project', 'project', root, list),
    ['a.md:1: Closes Example-Owner/Example-Project#1', 'a.md:3: the ExampleProject solution', 'a.md:4: example_project.conf']);
  assert.deepEqual(mentions('example-owner', 'owner', root, list),
    ['a.md:1: Closes Example-Owner/Example-Project#1', '.claude-plugin/marketplace.json:8: "name": "example-owner-tools"']);
});
