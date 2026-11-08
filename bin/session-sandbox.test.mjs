import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, dirname, join} from 'node:path';
import {fakeAnswers, fakeDocker, git, gitEnv, here, listenUnix, realCommand, runClone, withoutSandboxPaths} from './fixture.mjs';

// The real bwrap, which needs unprivileged user namespaces (bin/README.md, The write limit).
const userns = spawnSync('bwrap', ['--unshare-user', '--ro-bind', '/', '/', 'true']).status === 0;
const skip = userns ? false : 'bwrap is missing or cannot create a user namespace here';

// The tests that check what the limit makes read-only need the rig outside /tmp and $TMPDIR, which the limit leaves
// writable, so they skip when the repository itself lies there, as a reviewer's scratch copy does (the agent-guard
// tests' sandboxInTemp does the same).
const repository = realpathSync(join(here, '..'));
const skipOutside = skip || (['/tmp', tmpdir()].some(dir => {
  const real = realpathSync(dir);
  return repository === real || repository.startsWith(`${real}/`);
}) && 'the repository lies under /tmp or $TMPDIR, which the limit leaves writable, so the rig cannot be outside them');

// A rig outside /tmp, which the limit leaves writable: in the repository, which this test may write in a session too.
// It holds a bare origin, a main checkout cloned from it, a run's clone `.worktrees/issue-1` of that origin on ticket/1
// that reads the main checkout's objects through an alternate, as ticket-runner makes it, a separate Triphammer
// checkout holding this branch's session-sandbox and the config.sh it sources, and a home directory with a Claude Code directory whose
// settings.json and skills are there, a Codex directory with its config.toml and rules, local-audit's
// codex-settings, and NuGet's NuGet.Config. `inside` runs a shell command under the limit in the run's clone, as the
// runner does, with `env` added to its environment, and returns its exit status and output.
function sandboxRig(t) {
  const root = mkdtempSync(join(here, '..', '.session-sandbox-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const origin = join(root, 'origin.git');
  const main = join(root, 'main');
  const triphammer = join(root, 'triphammer');
  const home = join(root, 'home');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, main);
  writeFileSync(join(main, 'tracked.txt'), 'main\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'first');
  git(main, 'push', '-q', 'origin', 'HEAD:main');
  const worktree = join(main, '.worktrees/issue-1');
  runClone(main, origin, worktree);
  git(worktree, 'checkout', '-q', '-b', 'ticket/1');
  mkdirSync(join(triphammer, 'bin'), {recursive: true});
  copyFileSync(join(here, 'session-sandbox'), join(triphammer, 'bin/session-sandbox'));
  copyFileSync(join(here, 'config.sh'), join(triphammer, 'bin/config.sh'));
  git(triphammer, 'init', '-q', '-b', 'main');
  git(triphammer, 'add', '.');
  git(triphammer, 'commit', '-q', '-m', 'first');
  mkdirSync(join(home, '.claude/skills'), {recursive: true});
  writeFileSync(join(home, '.claude/settings.json'), '{}\n');
  writeFileSync(join(home, '.claude/.credentials.json'), '{}\n');
  mkdirSync(join(home, '.codex/rules'), {recursive: true});
  writeFileSync(join(home, '.codex/config.toml'), '');
  writeFileSync(join(home, '.codex/auth.json'), '{}\n');
  mkdirSync(join(home, '.local/state/local-audit'), {recursive: true});
  writeFileSync(join(home, '.local/state/local-audit/codex-settings'), 'weekly_cap=1\n');
  mkdirSync(join(home, '.nuget/NuGet'), {recursive: true});
  writeFileSync(join(home, '.nuget/NuGet/NuGet.Config'), '<configuration />\n');
  const {TMPDIR, XDG_STATE_HOME, ...env} = withoutSandboxPaths(gitEnv);
  const inside = (command, extra = {}) => {
    const result = spawnSync(join(triphammer, 'bin/session-sandbox'), [worktree, 'sh', '-c', command],
      {cwd: worktree, env: {...env, HOME: home, ...extra}, encoding: 'utf8'});
    return {status: result.status, output: result.stdout + result.stderr};
  };
  return {root, main, triphammer, home, worktree, env: {...env, HOME: home}, inside};
}

// Runs `before` under the limit, then `during` outside while the command waits, then `after` in the same command, with
// `extra` in the environment; returns the command's exit status and output.
async function insideAround(t, r, before, during, after, extra = {}) {
  const signal = mkdtempSync('/tmp/session-sandbox-signal-');
  t.after(() => rmSync(signal, {recursive: true, force: true}));
  const child = spawn(join(r.triphammer, 'bin/session-sandbox'), [r.worktree, 'sh', '-c', `${before}; : > '${signal}/paused'
for i in $(seq 100); do [ -e '${signal}/resumed' ] && break; sleep 0.1; done; ${after}`],
  {cwd: r.worktree, env: {...r.env, ...extra}});
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exited = new Promise(done => child.on('exit', done));
  for (let i = 0; i < 100 && !existsSync(join(signal, 'paused')); i++) await new Promise(done => setTimeout(done, 100));
  await during();
  writeFileSync(join(signal, 'resumed'), '');
  return {status: await exited, output};
}

// Asserts that writing each of `paths` under the limit, with `extra` in the environment, is refused and leaves it as
// it was.
function assertReadOnly(r, paths, extra) {
  for (const path of paths) {
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const {status, output} = r.inside(`echo planted > '${path}'`, extra);
    assert.notEqual(status, 0, `${path} was written`);
    assert.match(output, /Read-only file system/, path);
    assert.equal(existsSync(path) ? readFileSync(path, 'utf8') : null, before, `${path} changed`);
  }
}

const pythonWrite = path => `python3 -c "open('${path}', 'w').write('planted')"`;

test('under the limit, the main checkout, Triphammer\'s checkout and the home directory are read-only', {skip: skipOutside}, t => {
  const r = sandboxRig(t);
  const targets = {
    "a tracked file of the main checkout": join(r.main, 'tracked.txt'),
    "a new file in the main checkout": join(r.main, 'new.txt'),
    "a tracked file of Triphammer's checkout": join(r.triphammer, 'bin/session-sandbox'),
    'a file in the home directory': join(r.home, 'outside'),
    "Claude Code's settings.json": join(r.home, '.claude/settings.json'),
    "a file in Claude Code's skills": join(r.home, '.claude/skills/planted.md'),
    "Codex's config.toml": join(r.home, '.codex/config.toml'),
    "a file in Codex's rules": join(r.home, '.codex/rules/planted.rules'),
    "local-audit's codex-settings": join(r.home, '.local/state/local-audit/codex-settings'),
    "NuGet's NuGet.Config": join(r.home, '.nuget/NuGet/NuGet.Config'),
  };
  for (const [what, path] of Object.entries(targets)) {
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    for (const [how, command] of [['python', pythonWrite(path)], ['a shell redirect', `echo planted > '${path}'`]]) {
      const {status, output} = r.inside(command);
      assert.notEqual(status, 0, `${what} was written with ${how}`);
      assert.match(output, /Read-only file system/, `${what} with ${how}: ${output}`);
      assert.equal(existsSync(path) ? readFileSync(path, 'utf8') : null, before, `${what} changed with ${how}`);
    }
  }
  assert.equal(git(r.main, 'status', '--porcelain', '--untracked-files=no'), '');
});

test("under the limit, Triphammer's checkout's .git is read-only, so no config or hook there reaches the next tick", {skip: skipOutside}, t => {
  const r = sandboxRig(t);
  const config = join(r.triphammer, '.git/config');
  const before = readFileSync(config, 'utf8');
  const fsmonitor = r.inside(`git -C '${r.triphammer}' config core.fsmonitor 'echo planted > tracked; false'`);
  assert.notEqual(fsmonitor.status, 0, 'core.fsmonitor was set');
  assert.match(fsmonitor.output, /Read-only file system|could not lock config file/, fsmonitor.output);
  assert.equal(readFileSync(config, 'utf8'), before);
  assertReadOnly(r, [config, join(r.triphammer, '.git/hooks/post-merge')]);
});

// A loose object of the main checkout's store, which the run's clone reads through its alternate: its path and the
// content git reads for it.
function looseObject(r) {
  const id = git(r.main, 'rev-parse', 'HEAD:tracked.txt');
  return {id, path: join(r.main, '.git/objects', id.slice(0, 2), id.slice(2)), content: git(r.main, 'cat-file', '-p', id)};
}

test("under the limit, the main checkout's .git is read-only, the objects the run's clone reads through its alternate included", {skip: skipOutside}, t => {
  const r = sandboxRig(t);
  const objects = join(r.main, '.git/objects');
  assert.equal(readFileSync(join(r.worktree, '.git/objects/info/alternates'), 'utf8').trim(), objects);
  const {path} = looseObject(r);
  const config = join(r.main, '.git/config');
  const before = readFileSync(config, 'utf8');
  const fsmonitor = r.inside(`git -C '${r.main}' config core.fsmonitor 'echo planted > tracked; false'`);
  assert.notEqual(fsmonitor.status, 0, 'core.fsmonitor was set');
  assert.match(fsmonitor.output, /Read-only file system|could not lock config file/, fsmonitor.output);
  assert.equal(readFileSync(config, 'utf8'), before);
  assertReadOnly(r, [config, join(r.main, '.git/hooks/post-merge'), join(r.main, '.git/refs/heads/planted'), path,
    join(objects, 'info/alternates'), join(objects, 'planted')]);
});

test("a session cannot plant other content under a loose object's name in the main checkout's store", {skip: skipOutside}, t => {
  const r = sandboxRig(t);
  const {id, path, content} = looseObject(r);
  writeFileSync(join(r.root, 'planted.txt'), 'planted\n');
  const other = git(r.worktree, 'hash-object', '-w', join(r.root, 'planted.txt'));
  const planted = join(r.worktree, '.git/objects', other.slice(0, 2), other.slice(2));
  const through = `$(cat .git/objects/info/alternates)/${id.slice(0, 2)}/${id.slice(2)}`;
  for (const target of [path, through]) {
    for (const command of [`chmod u+w "${target}"; cp '${planted}' "${target}"`, `cp '${planted}' "${target}.new" && mv -f "${target}.new" "${target}"`,
      `rm -f "${target}" && cp '${planted}' "${target}"`]) {
      const {status, output} = r.inside(command);
      assert.notEqual(status, 0, `${command} succeeded: ${output}`);
      assert.match(output, /Read-only file system/, command);
    }
  }
  assert.equal(git(r.main, 'cat-file', '-p', id), content);
  assert.equal(git(r.worktree, 'cat-file', '-p', id), content, "the run's clone still reads the original object");
});

test('a run directory whose git directory lies outside it, as a git worktree\'s does, runs nothing', {skip}, t => {
  const r = sandboxRig(t);
  const worktree = join(r.main, '.worktrees/issue-2');
  git(r.main, 'worktree', 'add', '-q', '-b', 'ticket/2', worktree);
  const result = spawnSync(join(r.triphammer, 'bin/session-sandbox'), [worktree, 'sh', '-c', 'echo ran'],
    {cwd: worktree, env: {...gitEnv, HOME: r.home}, encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /lies outside it; a session runs only in a clone of its own/);
});

test('under the limit, the run\'s clone, its commits, /tmp and what Claude Code, Codex, local-audit and the hooks write are writable', {skip}, t => {
  const r = sandboxRig(t);
  const scratch = mkdtempSync('/tmp/session-sandbox-test-');
  t.after(() => rmSync(scratch, {recursive: true, force: true}));
  const {status, output} = r.inside(`set -e
echo work > work.txt
${pythonWrite(join(r.worktree, 'script.txt'))}
git add work.txt script.txt && git commit -q -m work
echo tmp > '${scratch}/file'
mkdir -p '${r.home}/.claude/projects/p' && echo session > '${r.home}/.claude/projects/p/session.jsonl'
echo ran > '${r.home}/.local/state/triphammer/humanizer/marker'
echo override >> '${r.home}/.local/state/triphammer/guard-overrides.log'
echo 1 > '${r.home}/.local/state/local-audit/codex-runs.new'
mv '${r.home}/.local/state/local-audit/codex-runs.new' '${r.home}/.local/state/local-audit/codex-runs'
mkdir -p '${r.home}/.codex/sessions/2026' && echo session > '${r.home}/.codex/sessions/2026/s.jsonl'
echo log > '${r.home}/.codex/log/codex-tui.log'
mkdir -p '${r.home}/.codex/tmp/arg0' && ln -s /bin/true '${r.home}/.codex/tmp/arg0/apply_patch'
echo refreshed > '${r.home}/.codex/auth.json'
echo refreshed > '${r.home}/.claude/.credentials.json'
echo snapshot > '${r.home}/.claude/shell-snapshots/snapshot-bash.sh'
mkdir -p '${r.home}/.claude/todos' && echo todo > '${r.home}/.claude/todos/t.json'`);
  assert.equal(status, 0, output);
  assert.equal(git(r.worktree, 'log', '-1', '--format=%s'), 'work');
  const commit = git(r.worktree, 'rev-parse', 'HEAD');
  assert.equal(readFileSync(join(r.worktree, '.git/refs/heads/ticket/1'), 'utf8').trim(), commit, "the commit is in the clone's own .git");
  assert.throws(() => git(r.main, 'cat-file', '-e', commit), "the main checkout's store did not get it");
  assert.equal(readFileSync(join(scratch, 'file'), 'utf8'), 'tmp\n');
  assert.equal(readFileSync(join(r.home, '.claude/projects/p/session.jsonl'), 'utf8'), 'session\n');
  assert.equal(readFileSync(join(r.home, '.local/state/triphammer/guard-overrides.log'), 'utf8'), 'override\n');
  assert.equal(readFileSync(join(r.home, '.local/state/local-audit/codex-runs'), 'utf8'), '1\n');
  assert.equal(readFileSync(join(r.home, '.codex/sessions/2026/s.jsonl'), 'utf8'), 'session\n');
  assert.equal(readFileSync(join(r.home, '.codex/log/codex-tui.log'), 'utf8'), 'log\n');
  assert.equal(readFileSync(join(r.home, '.codex/auth.json'), 'utf8'), 'refreshed\n');
  assert.equal(readFileSync(join(r.home, '.claude/.credentials.json'), 'utf8'), 'refreshed\n');
  assert.equal(readFileSync(join(r.home, '.claude/shell-snapshots/snapshot-bash.sh'), 'utf8'), 'snapshot\n');
  assert.equal(readFileSync(join(r.home, '.claude/todos/t.json'), 'utf8'), 'todo\n');
});

test("under the limit, Codex's databases go to a directory of their own that is gone when the command ends", {skip}, t => {
  const r = sandboxRig(t);
  const sqlite = join(r.home, '.codex/sqlite');
  const {status, output} = r.inside(`set -e
test "$CODEX_SQLITE_HOME" = '${sqlite}'
echo state > "$CODEX_SQLITE_HOME/state_5.sqlite" && : > "$CODEX_SQLITE_HOME/state_5.sqlite-wal"
rm "$CODEX_SQLITE_HOME/state_5.sqlite-wal"
cat "$CODEX_SQLITE_HOME/state_5.sqlite"`);
  assert.equal(status, 0, output);
  assert.equal(output, 'state\n');
  assert.ok(!existsSync(sqlite), 'the databases outlived the command');
});

test("under the limit, what Claude Code or Codex adds elsewhere in its directory is gone when the command ends", {skip}, t => {
  const r = sandboxRig(t);
  const added = [join(r.home, '.claude/keybindings.json'), join(r.home, '.claude/history.jsonl'),
    join(r.home, '.codex/models_cache.json'), join(r.home, '.codex/state_5.sqlite')];
  const {status, output} = r.inside(added.map(path => `echo added > '${path}' && cat '${path}'`).join('\n'));
  assert.equal(status, 0, output);
  assert.equal(output, 'added\n'.repeat(added.length));
  for (const path of added) assert.ok(!existsSync(path), `${path} outlived the command`);
});

// What later Claude Code and Codex sessions load from their directories, and the auto memory of the run directory:
// each part, and for a directory, the file in it to write.
function loadedParts(r) {
  const memory = join('.claude/projects', realpathSync(r.worktree).replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  return [
    ...['CLAUDE.md', 'settings.json', 'settings.local.json'].map(name => [`.claude/${name}`]),
    ...[['skills', 'planted/SKILL.md'], ['agents', 'planted.md'], ['commands', 'planted.md'], ['hooks', 'planted.sh'],
      ['rules', 'planted.md'], ['output-styles', 'planted.md'], ['plugins', 'installed_plugins.json']]
      .map(([name, file]) => [`.claude/${name}`, file]),
    [memory, 'MEMORY.md'],
    ...['AGENTS.md', 'AGENTS.override.md', 'config.toml', '.env', 'hooks.json'].map(name => [`.codex/${name}`]),
    ...[['rules', 'planted.rules'], ['skills', 'planted/SKILL.md'], ['prompts', 'planted.md'], ['agents', 'planted.toml'],
      ['plugins', 'planted.json'], ['themes', 'planted.tmTheme']].map(([name, file]) => [`.codex/${name}`, file]),
  ].map(([part, file]) => ({part: join(r.home, part), path: join(r.home, part, file ?? '')}));
}

for (const existed of [true, false]) {
  test(`under the limit, the instructions, settings, skills, agents, commands, hooks, rules, output styles and memory later Claude Code and Codex sessions load cannot be ${existed ? 'changed' : 'created'}`, {skip}, t => {
    const r = sandboxRig(t);
    const parts = loadedParts(r);
    for (const {part, path} of parts) {
      rmSync(part, {recursive: true, force: true});
      if (existed) {
        mkdirSync(dirname(path), {recursive: true});
        writeFileSync(path, 'owner\n');
      }
    }
    for (const {part, path} of parts) {
      const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
      const commands = [pythonWrite(path), `echo planted > '${path}'`, `echo planted > /tmp/planted-$$ && mv -f /tmp/planted-$$ '${path}'`,
        part === path ? `rm -f '${path}' && echo planted > '${path}'` : `mkdir -p '${part}/sub' && echo planted > '${part}/sub/planted'`];
      for (const command of commands) {
        const {output} = r.inside(`(${command}) 2>/dev/null && echo wrote; cat '${path}' 2>/dev/null; true`);
        assert.doesNotMatch(output, /wrote|planted/, `${path} was written with ${command}`);
      }
      assert.equal(existsSync(path) ? readFileSync(path, 'utf8') : null, before, `${path} changed`);
      assert.ok(!existsSync(join(part, 'sub')), `${part}/sub was created`);
    }
    const {output} = r.inside('echo "$CLAUDE_CODE_DISABLE_AUTO_MEMORY"');
    assert.equal(output, '1\n', 'Claude Code loads no auto memory inside');
  });
}

// The shared caches directory in the rig's home, and a project's cache directory in it, created as ticket-runner does.
const cachesDir = r => join(r.home, '.local/state/triphammer/caches');
function cacheDir(r, project) {
  const dir = join(cachesDir(r), project);
  mkdirSync(dir, {recursive: true});
  return dir;
}

// Each variable the limit points a cache at, and its directory in the cache directory.
const cacheVars = {XDG_CACHE_HOME: 'xdg', npm_config_cache: 'npm', NUGET_PACKAGES: 'nuget/packages',
  NUGET_HTTP_CACHE_PATH: 'nuget/http-cache', NUGET_PLUGINS_CACHE_PATH: 'nuget/plugins-cache', BUILDX_CONFIG: 'buildx'};

test("under the limit, the home directory's caches, NuGet's and buildx's among them, are read-only", {skip: skipOutside}, t => {
  const r = sandboxRig(t);
  const docker = join(r.home, '.docker');
  for (const dir of ['.cache', '.npm/_cacache', '.nuget/packages', '.local/share/NuGet/http-cache', '.docker/buildx',
    '.docker/cli-plugins']) {
    mkdirSync(join(r.home, dir), {recursive: true});
  }
  writeFileSync(join(docker, 'config.json'), '{}\n');
  const paths = [join(r.home, '.cache/planted'), join(r.home, '.npm/_cacache/planted'),
    join(r.home, '.nuget/packages/planted.nupkg'), join(r.home, '.local/share/NuGet/http-cache/planted.dat'),
    join(docker, 'buildx/current'), join(docker, 'config.json'), join(docker, 'cli-plugins/docker-planted')];
  assertReadOnly(r, paths, {TRIPHAMMER_CACHE_DIR: cacheDir(r, 'example')});
  assertReadOnly(r, paths);
});

test("under the limit, the cache variables point into the project's cache directory, over their values outside", {skip}, t => {
  const r = sandboxRig(t);
  const own = cacheDir(r, 'example');
  const outside = join(r.root, 'outside');
  const extra = {TRIPHAMMER_CACHE_DIR: own, NPM_CONFIG_CACHE: join(outside, 'NPM'),
    ...Object.fromEntries(Object.keys(cacheVars).map(name => [name, join(outside, name)]))};
  const {status, output} = r.inside(`set -e
${Object.keys(cacheVars).map(name => `mkdir -p "$${name}/p" && echo ${name} > "$${name}/p/file"`).join('\n')}
echo "npm: \${NPM_CONFIG_CACHE-unset}"`, extra);
  assert.equal(status, 0, output);
  assert.equal(output, 'npm: unset\n');
  for (const [name, dir] of Object.entries(cacheVars)) {
    assert.equal(readFileSync(join(own, dir, 'p/file'), 'utf8'), `${name}\n`, name);
    assert.ok(!existsSync(join(outside, name, 'p')), `${name} went to its value outside`);
  }
});

test("a project's session can neither read nor write another project's caches, and a later session of its own reads them", {skip}, t => {
  const r = sandboxRig(t);
  const first = cacheDir(r, 'example');
  const second = cacheDir(r, 'other-project');
  const planted = join(first, 'nuget/packages/p/p.nupkg');
  const wrote = r.inside('mkdir -p "$NUGET_PACKAGES/p" && echo package > "$NUGET_PACKAGES/p/p.nupkg"',
    {TRIPHAMMER_CACHE_DIR: first});
  assert.equal(wrote.status, 0, wrote.output);
  assert.equal(readFileSync(planted, 'utf8'), 'package\n');
  const other = r.inside(`ls -A '${cachesDir(r)}'; cat '${planted}' 2>/dev/null && echo read
mkdir -p '${dirname(planted)}' && echo planted > '${planted}'`, {TRIPHAMMER_CACHE_DIR: second});
  assert.equal(other.output, 'other-project\n', "another project's session sees the first's caches");
  assert.equal(readFileSync(planted, 'utf8'), 'package\n', "another project's session changed the first's caches");
  const later = r.inside('cat "$NUGET_PACKAGES/p/p.nupkg"', {TRIPHAMMER_CACHE_DIR: first});
  assert.equal(later.output, 'package\n');
});

test('without a cache directory, the caches go to a tmpfs that is gone when the command ends', {skip}, t => {
  const r = sandboxRig(t);
  const existing = cacheDir(r, 'example');
  writeFileSync(join(existing, 'file'), 'cached\n');
  const browsers = join(r.home, '.cache/ms-playwright');
  mkdirSync(browsers, {recursive: true});
  const {status, output} = r.inside(`set -e
${Object.keys(cacheVars).map(name => `echo ${name} > "$${name}/file" && cat "$${name}/file"`).join('\n')}
ls -A '${cachesDir(r)}'
echo "$PLAYWRIGHT_BROWSERS_PATH"`);
  assert.equal(status, 0, output);
  assert.equal(output, `${Object.keys(cacheVars).join('\n')}\nbuildx\nnpm\nnuget\nxdg\n${realpathSync(browsers)}\n`);
  assert.deepEqual(readdirSync(cachesDir(r)), ['example']);
  assert.deepEqual(readdirSync(existing), ['file']);
});

test('a cache directory elsewhere than directly in the shared caches directory runs nothing', {skip}, t => {
  const r = sandboxRig(t);
  const caches = cachesDir(r);
  mkdirSync(join(caches, 'example/nested'), {recursive: true});
  mkdirSync(join(r.home, '.cache'), {recursive: true});
  symlinkSync(join(r.home, '.cache'), join(caches, 'linked'));
  for (const dir of [join(r.home, '.cache'), caches, join(caches, 'example/nested'), join(caches, 'missing'),
    join(caches, 'linked')]) {
    const {status, output} = r.inside('echo ran', {TRIPHAMMER_CACHE_DIR: dir});
    assert.equal(status, 1, `${dir}: ${output}`);
    assert.doesNotMatch(output, /ran/);
    assert.match(output, /must be a directory of/);
  }
});

test("with dotnet installed and no NuGet user config, the session gets a read-only one with NuGet's default source, and none outside", {skip: skipOutside}, t => {
  const r = sandboxRig(t);
  const config = join(r.home, '.nuget/NuGet/NuGet.Config');
  rmSync(config);
  const bin = join(r.root, 'bin');
  mkdirSync(bin);
  fakeAnswers(bin, 'dotnet', join(r.root, 'dotnet'), {});
  const extra = {PATH: `${bin}${delimiter}${gitEnv.PATH}`};
  const {output} = r.inside(`cat '${config}'; echo planted > '${config}'`, extra);
  assert.match(output, /<add key="nuget.org" value="https:\/\/api.nuget.org\/v3\/index.json" protocolVersion="3" \/>/);
  assert.match(output, /Read-only file system/);
  assert.ok(!existsSync(config), 'NuGet.Config was created outside');
  assertReadOnly(r, [join(r.home, '.nuget/NuGet/nuget.config'), join(r.home, '.nuget/config')], extra);
});

test('a Codex directory without a config.toml gets an empty read-only one under the limit, and none outside', {skip}, t => {
  const r = sandboxRig(t);
  const config = join(r.home, '.codex/config.toml');
  rmSync(config);
  const {status, output} = r.inside(`wc -c < '${config}' && echo 'notify = ["planted"]' > '${config}'`);
  assert.notEqual(status, 0, 'config.toml was written');
  assert.match(output, /^0\n.*Read-only file system/s);
  assert.ok(!existsSync(config), 'config.toml was created outside');
});

test('with docker installed and no Docker config directory, it gets none and no config.json can be planted', {skip: skipOutside}, t => {
  const r = sandboxRig(t);
  const bin = join(r.root, 'bin');
  mkdirSync(bin);
  fakeDocker(join(r.root, 'docker'), bin);
  const path = {PATH: `${bin}${delimiter}${gitEnv.PATH}`};
  const {status, output} = r.inside('true', path);
  assert.equal(status, 0, output);
  const docker = join(r.home, '.docker');
  assert.ok(!existsSync(docker), '.docker was created');
  const planted = r.inside(`mkdir -p '${docker}' && echo '{}' > '${docker}/config.json'`, path);
  assert.notEqual(planted.status, 0, planted.output);
  assert.match(planted.output, /Read-only file system/);
});

test("under the limit, the dotnet CLI's state is writable for the session alone and the SDK beside it read-only", {skip}, t => {
  const r = sandboxRig(t);
  const dotnet = join(r.home, '.dotnet');
  for (const dir of ['sdk/9.9.9', 'shared', 'host', 'packs', 'templates', 'tools', 'toolResolverCache']) {
    mkdirSync(join(dotnet, dir), {recursive: true});
  }
  writeFileSync(join(dotnet, 'dotnet'), 'host\n', {mode: 0o755});
  writeFileSync(join(dotnet, 'sdk/9.9.9/dotnet.dll'), 'sdk\n');
  writeFileSync(join(dotnet, 'toolResolverCache/old'), 'old\n');
  const {status, output} = r.inside(`set -e
cat '${dotnet}/sdk/9.9.9/dotnet.dll'
: > '${dotnet}/9.9.9.dotnetFirstUseSentinel'
test ! -e '${dotnet}/toolResolverCache/old'
mkdir -p '${dotnet}/toolResolverCache/1' '${dotnet}/TelemetryStorageService' '${r.home}/.templateengine/dotnetcli/9.9.9'
echo cache > '${dotnet}/toolResolverCache/1/tool'
echo cache > '${r.home}/.templateengine/dotnetcli/9.9.9/templatecache.json'`);
  assert.equal(status, 0, output);
  assert.match(output, /^sdk$/m);
  assert.ok(!existsSync(join(dotnet, '9.9.9.dotnetFirstUseSentinel')), 'the sentinel outlived the session');
  assert.ok(!existsSync(join(dotnet, 'toolResolverCache/1')), "the session's toolResolverCache outlived it");
  assert.ok(!existsSync(join(r.home, '.templateengine/dotnetcli')), "the session's template cache outlived it");
  assert.equal(readFileSync(join(dotnet, 'toolResolverCache/old'), 'utf8'), 'old\n');
  assertReadOnly(r, ['dotnet', 'sdk/9.9.9/dotnet.dll', 'sdk/9.9.9/planted', 'shared/planted', 'host/planted',
    'packs/planted', 'templates/planted', 'tools/planted'].map(path => join(dotnet, path)));
});

test('with dotnet installed, the CLI home that DOTNET_CLI_HOME names gets writable state for the session', {skip: skipOutside}, t => {
  const r = sandboxRig(t);
  const cliHome = join(r.root, 'cli-home');
  mkdirSync(cliHome);
  const bin = join(r.root, 'bin');
  mkdirSync(bin);
  fakeAnswers(bin, 'dotnet', join(r.root, 'dotnet'), {});
  const extra = {DOTNET_CLI_HOME: cliHome, PATH: `${bin}${delimiter}${gitEnv.PATH}`};
  const {status, output} = r.inside(
    `: > '${cliHome}/.dotnet/9.9.9.dotnetFirstUseSentinel' && : > '${cliHome}/.templateengine/cache'`, extra);
  assert.equal(status, 0, output);
  assertReadOnly(r, [join(cliHome, 'planted')], extra);
});

test('without docker or dotnet, the home directory gets neither directory', {skip}, t => {
  const r = sandboxRig(t);
  const bin = join(r.root, 'bin');
  mkdirSync(bin);
  for (const name of ['bash', 'env', 'sh', 'git', 'bwrap', 'readlink', 'dirname', 'mkdir']) {
    symlinkSync(realCommand(name), join(bin, name));
  }
  const {status, output} = r.inside('true', {PATH: bin});
  assert.equal(status, 0, output);
  for (const name of ['.docker', '.dotnet', '.templateengine']) {
    assert.ok(!existsSync(join(r.home, name)), `${name} was created`);
  }
});

test('under the limit, the command cannot see or signal the processes outside', {skip}, t => {
  const r = sandboxRig(t);
  const {status, output} = r.inside(`kill -0 ${process.pid} 2>/dev/null && echo signalled; ls /proc | grep -cx '[0-9]*'`);
  assert.equal(status, 0, output);
  assert.doesNotMatch(output, /signalled/);
  assert.ok(Number(output.trim()) < 10, `the command sees ${output.trim()} processes`);
});

test('a run directory outside any git checkout runs nothing', {skip}, t => {
  const r = sandboxRig(t);
  const outside = join(r.root, 'plain');
  mkdirSync(outside);
  const result = spawnSync(join(r.triphammer, 'bin/session-sandbox'), [outside, 'sh', '-c', 'echo ran'],
    {env: {...gitEnv, HOME: r.home, GIT_CEILING_DIRECTORIES: r.root}, encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /is not in a git checkout/);
});

// The App's files, a token cache for two accounts and two sessions' token directories in the shared directory, as the
// machine and ticket-runner leave them, in the rig's home; `own` is the token file of the session under test.
function tokenFiles(r) {
  const app = join(r.home, '.config/github-app');
  const cache = join(r.home, '.cache/github-app');
  const tokens = join(r.home, '.local/state/triphammer/tokens');
  for (const dir of [app, cache, join(tokens, 'example'), join(tokens, 'other-project')]) mkdirSync(dir, {recursive: true});
  const files = {
    "the App's private key": join(app, 'agents.pem'),
    "the App's id": join(app, 'app-id'),
    "the App's owner file": join(app, 'owner'),
    "the session account's token cache": join(cache, 'token-example-owner.json'),
    "another account's token cache": join(cache, 'token-other-org.json'),
    "another session's token file": join(tokens, 'other-project/token.json'),
  };
  for (const path of Object.values(files)) writeFileSync(path, 'secret\n');
  const own = join(tokens, 'example/token.json');
  writeFileSync(own, '{"token":"ghs_first"}\n');
  return {files, own};
}

test("under the limit, the App's files, the token cache and other sessions' tokens cannot be read; the session's own token can", {skip}, t => {
  const r = sandboxRig(t);
  const {files, own} = tokenFiles(r);
  for (const extra of [{TRIPHAMMER_TOKEN_FILE: own}, {}]) {
    for (const [what, path] of Object.entries(files)) {
      const {status, output} = r.inside(`cat '${path}'`, extra);
      assert.notEqual(status, 0, `${what} was read with ${JSON.stringify(extra)}`);
      assert.doesNotMatch(output, /secret/, what);
    }
    const listed = r.inside(`ls -A '${join(r.home, '.config/github-app')}' '${join(r.home, '.cache/github-app')}'`, extra);
    assert.equal(listed.status, 0, listed.output);
    assert.doesNotMatch(listed.output, /agents|token-/, 'the hidden directories list empty');
  }
  const read = r.inside(`cat '${own}'`, {TRIPHAMMER_TOKEN_FILE: own});
  assert.equal(read.status, 0, read.output);
  assert.equal(read.output, '{"token":"ghs_first"}\n');
  const without = r.inside(`cat '${own}'`);
  assert.notEqual(without.status, 0, 'a sandbox given no token file reads no token');
  assert.doesNotMatch(without.output, /ghs_first/);
  assertReadOnly(r, [own, join(dirname(own), 'planted')], {TRIPHAMMER_TOKEN_FILE: own});
});

test('a token file the runner rewrites through a rename shows inside the limit while the session runs', {skip}, async t => {
  const r = sandboxRig(t);
  const {own} = tokenFiles(r);
  const {status, output} = await insideAround(t, r, `cat '${own}'`, () => {
    writeFileSync(`${own}.new`, '{"token":"ghs_second"}\n');
    renameSync(`${own}.new`, own);
  }, `cat '${own}'`, {TRIPHAMMER_TOKEN_FILE: own});
  assert.equal(status, 0, output);
  assert.equal(output, '{"token":"ghs_first"}\n{"token":"ghs_second"}\n');
});

test('a token file outside the shared tokens directory runs nothing', {skip}, t => {
  const r = sandboxRig(t);
  tokenFiles(r);
  for (const file of [join(r.home, '.config/github-app/agents.pem'), join(r.home, '.local/state/triphammer/tokens/token.json')]) {
    const {status, output} = r.inside('echo ran', {TRIPHAMMER_TOKEN_FILE: file});
    assert.equal(status, 1, output);
    assert.doesNotMatch(output, /ran/);
    assert.match(output, /must lie in a directory of/);
  }
});

// A shell command that connects to the Unix socket at `path` and prints `connected <path>`, or why it could not.
const connect = path => `python3 -c "import socket, sys; s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); print('connected', sys.argv[1])" '${path}'`;

test("under the limit, the runtime directory's bus and agent sockets cannot be reached and their variables are gone; a rootless Docker socket there can", {skip: skipOutside}, async t => {
  const r = sandboxRig(t);
  const runtime = join(r.root, 'runtime');
  mkdirSync(join(runtime, 'gnupg'), {recursive: true, mode: 0o700});
  const sockets = {bus: join(runtime, 'bus'), agent: join(runtime, 'openssh_agent'),
    gpg: join(runtime, 'gnupg/S.gpg-agent'), docker: join(runtime, 'docker.sock')};
  for (const path of Object.values(sockets)) await listenUnix(t, path);
  const env = {XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${sockets.bus}`,
    SSH_AUTH_SOCK: sockets.agent, GPG_AGENT_INFO: `${sockets.gpg}:0:1`, DOCKER_HOST: `unix://${sockets.docker}`,
    TRIPHAMMER_DOCKER: '1'};
  for (const what of ['bus', 'agent', 'gpg']) {
    const {status, output} = r.inside(connect(sockets[what]), env);
    assert.notEqual(status, 0, `the ${what} socket was reached: ${output}`);
    assert.match(output, /FileNotFoundError/, output);
  }
  const docker = r.inside(connect(sockets.docker), env);
  assert.equal(docker.status, 0, docker.output);
  assert.match(docker.output, /^connected /);
  const {status, output} = r.inside('echo "dbus=${DBUS_SESSION_BUS_ADDRESS-unset} ssh=${SSH_AUTH_SOCK-unset}' +
    ' gpg=${GPG_AGENT_INFO-unset} runtime=$XDG_RUNTIME_DIR"; ls -A "$XDG_RUNTIME_DIR"; stat -c %a "$XDG_RUNTIME_DIR";' +
    ' echo made > "$XDG_RUNTIME_DIR/made" && cat "$XDG_RUNTIME_DIR/made"', env);
  assert.equal(status, 0, output);
  assert.equal(output, `dbus=unset ssh=unset gpg=unset runtime=${runtime}\ndocker.sock\n700\nmade\n`);
  assert.ok(!existsSync(join(runtime, 'made')), "the runtime directory's tmpfs reached outside");
  const {TRIPHAMMER_DOCKER, ...withoutDocker} = env;
  const hidden = r.inside(`${connect(sockets.docker)}; ls -A "$XDG_RUNTIME_DIR"`, withoutDocker);
  assert.match(hidden.output, /FileNotFoundError/, hidden.output);
  assert.doesNotMatch(hidden.output, /docker\.sock/, hidden.output);
});

// A Docker socket outside the limit that DOCKER_HOST names, listening, and the machine's own Docker sockets.
async function dockerSocket(t, r, socket = join(r.root, 'docker.sock')) {
  const server = await listenUnix(t, socket);
  return {socket, server, env: {DOCKER_HOST: `unix://${socket}`}};
}
// What a daemon restart does to its socket: closes it, deletes it and listens at the same path again.
async function restart(t, r, server, socket) {
  await new Promise(done => server.close(done));
  rmSync(socket, {force: true});
  await dockerSocket(t, r, socket);
}
const machineSockets = ['/var/run/docker.sock', '/run/docker.sock'];
// Whether a socket at each of the machine's paths shows inside: `<path> socket` or `<path> none`.
const findSockets = machineSockets.map(path => `if [ -S ${path} ]; then echo "${path} socket"; else echo "${path} none"; fi`)
  .join('; ');
const isSocket = path => spawnSync('test', ['-S', path]).status === 0;

test("a project without Docker gets no Docker socket: one DOCKER_HOST names outside the limit and the machine's are hidden", {skip}, async t => {
  const r = sandboxRig(t);
  const {socket, env} = await dockerSocket(t, r);
  for (const extra of [{}, {TRIPHAMMER_DOCKER: 'true'}, {TRIPHAMMER_DOCKER: '0'}]) {
    const {status, output} = r.inside(`${connect(socket)}; test -S '${socket}' || echo "no socket"`, {...env, ...extra});
    assert.equal(status, 0, output);
    assert.doesNotMatch(output, /^connected /m, output);
    assert.match(output, /FileNotFoundError/, output);
    assert.match(output, /^no socket$/m, output);
    const machine = r.inside(findSockets, {...env, ...extra});
    assert.equal(machine.output, machineSockets.map(path => `${path} none\n`).join(''), JSON.stringify(extra));
  }
  assert.ok(isSocket(socket), 'the socket outside is untouched');
});

test("a project with Docker reaches the Docker socket DOCKER_HOST names outside the limit, and not the machine's rootful ones", {skip}, async t => {
  const r = sandboxRig(t);
  const {socket, env} = await dockerSocket(t, r);
  const {status, output} = r.inside(connect(socket), {...env, TRIPHAMMER_DOCKER: '1'});
  assert.equal(status, 0, output);
  assert.equal(output, `connected ${socket}\n`);
  for (const host of [env.DOCKER_HOST, 'unix:///run/docker.sock', 'unix:///var/run/docker.sock']) {
    const machine = r.inside(findSockets, {DOCKER_HOST: host, TRIPHAMMER_DOCKER: '1'});
    assert.equal(machine.output, machineSockets.map(path => `${path} none\n`).join(''), host);
  }
});

test("a project with Docker reaches its own rootless daemon's socket and no other the machine file names", {skip}, async t => {
  const r = sandboxRig(t);
  const machine = join(r.root, 'machine');
  mkdirSync(join(machine, 'etc'), {recursive: true});
  const sockets = {own: join(r.root, 'example-docker-own/docker.sock'), other: join(r.root, 'example-docker-other/docker.sock')};
  for (const path of Object.values(sockets)) {
    mkdirSync(dirname(path), {recursive: true});
    await listenUnix(t, path);
  }
  writeFileSync(join(machine, 'etc/triphammer.conf'), `TRIPHAMMER_USER=example\n`
    + `TRIPHAMMER_DOCKER_SOCKET_OWN=${sockets.own}\nTRIPHAMMER_DOCKER_SOCKET_OTHER=${sockets.other}\n`);
  const env = {TRIPHAMMER_PROVISION_ROOT: machine, DOCKER_HOST: `unix://${sockets.own}`};
  const reached = docker => Object.entries(sockets).map(([name, path]) => {
    const {output} = r.inside(connect(path), {...env, ...docker});
    return `${name} ${/^connected /m.test(output) ? 'connected' : /FileNotFoundError/.test(output) ? 'hidden' : output}`;
  });
  assert.deepEqual(reached({TRIPHAMMER_DOCKER: '1'}), ['own connected', 'other hidden']);
  assert.deepEqual(reached({}), ['own hidden', 'other hidden']);
  for (const path of Object.values(sockets)) assert.ok(isSocket(path), `${path} outside is untouched`);
});

test('a project without Docker cannot reach a Docker socket the daemon deletes and makes again while the command runs', {skip}, async t => {
  const r = sandboxRig(t);
  const {socket, server, env} = await dockerSocket(t, r);
  const {status, output} = await insideAround(t, r, connect(socket), () => restart(t, r, server, socket), connect(socket),
    env);
  assert.equal(status, 1, output);
  assert.doesNotMatch(output, /^connected /m, output);
  assert.equal(output.match(/FileNotFoundError/g)?.length, 2, output);
  assert.ok(isSocket(socket), 'the socket outside was made again');
});

test('a project without Docker cannot reach a Docker socket made only after the command starts', {skip}, async t => {
  const r = sandboxRig(t);
  for (const socket of [join(r.root, 'docker.sock'), join(r.root, 'later/run/docker.sock')]) {
    const later = async () => {
      mkdirSync(dirname(socket), {recursive: true});
      await dockerSocket(t, r, socket);
    };
    const {status, output} = await insideAround(t, r, `test -e '${socket}' || echo absent`, later,
      `${connect(socket)}; ls -A '${r.root}'`, {DOCKER_HOST: `unix://${socket}`});
    assert.equal(status, 0, output);
    assert.match(output, /^absent$/m, output);
    assert.doesNotMatch(output, /^connected /m, output);
    assert.match(output, /FileNotFoundError/, output);
    assert.doesNotMatch(output, socket.endsWith('/run/docker.sock') ? /^later$/m : /^docker\.sock$/m, output);
    assert.ok(isSocket(socket), 'the socket outside was made');
  }
});

test('a project with Docker still reaches a Docker socket the daemon deletes and makes again while the command runs', {skip}, async t => {
  const r = sandboxRig(t);
  const {socket, server, env} = await dockerSocket(t, r);
  const {status, output} = await insideAround(t, r, connect(socket), () => restart(t, r, server, socket), connect(socket),
    {...env, TRIPHAMMER_DOCKER: '1'});
  assert.equal(status, 0, output);
  assert.equal(output, `connected ${socket}\nconnected ${socket}\n`);
});

// The user's own runtime directory, which the user manager and the session bus listen in, when this machine has one.
const userRuntime = `/run/user/${process.getuid()}`;
const noUserRuntime = skip || (existsSync(userRuntime) ? false : `${userRuntime} does not exist here`);
const missing = name => noUserRuntime || (realCommand(name) ? false : `${name} is not installed`);

for (const [name, command] of [
  ['systemd-run', 'systemd-run --user true'],
  ['systemctl', 'systemctl --user start triphammer-sandbox-probe.service'],
  ['busctl', 'busctl --user list'],
]) {
  test(`under the limit, \`${command}\` cannot reach the user manager, even with the variables naming it`, {skip: missing(name)}, t => {
    const r = sandboxRig(t);
    const {status, output} = r.inside(`${command} 2>&1; echo "exit $?"; ls -A "$XDG_RUNTIME_DIR"`,
      {XDG_RUNTIME_DIR: userRuntime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${userRuntime}/bus`});
    t.diagnostic(`${command}: ${output.trim()}`);
    assert.equal(status, 0, output);
    assert.doesNotMatch(output, /not found|Running as unit|NAME/, output);
    assert.match(output, /\nexit [1-9][0-9]*\n$/, `${command} succeeded, or ${userRuntime} is not empty inside: ${output}`);
  });
}
