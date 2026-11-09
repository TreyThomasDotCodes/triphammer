import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {gitEnv, gitRepo} from './test-git-repo.mjs';

// The owner checks of .github/workflows/risk-tier.yml, taken from the workflow itself and run with jq and bash, so a
// test fails when the workflow's own text changes. GitHub matches logins in any case, so these must too.
const workflow = readFileSync(new URL('../.github/workflows/risk-tier.yml', import.meta.url), 'utf8');
const filters = [...workflow.matchAll(/jq -r --arg owner "\$OWNER"[^']*'([^']*)'/g)].map(match => match[1]);
const [brake, approval, pushes] = filters;
const authorCheck = workflow.match(/if (\[ "\$\{?PULL_REQUEST_AUTHOR\b[^\]]*\])/)?.[1];
const holdCheck = workflow.match(/if (grep [^;]*\bhold <<< "\$labels");/)?.[1];
const ownerHold = workflow.match(/owner_hold="\$\(jq -r '([^']*)'/)?.[1];

const jq = (filter, input, owner) => {
  const result = spawnSync('jq', ['-r', '--arg', 'owner', owner, '--arg', 'since', '', filter],
    {input: JSON.stringify(input), encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const review = (login, state) => ({user: login === null ? null : {login}, state, commit_id: 'abc123', submitted_at: '2026-10-26T00:00:00Z'});

test('the workflow has the three owner filters, the author check and the hold check the tests run', () => {
  assert.equal(filters.length, 3);
  assert.ok(authorCheck);
  assert.ok(holdCheck);
  assert.ok(ownerHold);
});

test('a hold label holds the pull request whatever its case', () => {
  const held = labels => spawnSync('bash', ['-c', holdCheck], {env: {labels}}).status;
  assert.equal(held('bug\nhold'), 0);
  assert.equal(held('Hold'), 0);
  assert.equal(held('HOLD\nescalated'), 0);
  assert.notEqual(held('bug\nholder\non-hold'), 0);
  assert.notEqual(held(''), 0);
});

test("a hold someone other than a bot added holds until someone other than a bot removes it", () => {
  const held = events => jq(ownerHold, [events], 'owner-login');
  const human = login => ({login, type: 'User'});
  const app = {login: 'agents-app[bot]', type: 'Bot'};
  const hold = (event, actor, name = 'hold') => ({event, actor, label: {name}});
  assert.equal(held([hold('labeled', human('owner-login')), hold('unlabeled', app)]), 'labeled');
  assert.equal(held([hold('labeled', human('Owner-Login'), 'Hold'), hold('unlabeled', {login: 'other[bot]'})]), 'labeled');
  assert.equal(held([hold('labeled', human('owner-login')), hold('unlabeled', app), hold('unlabeled', human('owner-login'))]), 'unlabeled');
  assert.equal(held([hold('labeled', app), hold('unlabeled', app)]), '');
  assert.equal(held([hold('labeled', human('owner-login')), hold('unlabeled', app, 'holder'), {event: 'closed', actor: app}]), 'labeled');
  assert.equal(held([hold('unlabeled', human('owner-login')), hold('labeled', app)]), 'unlabeled');
});

test("the owner's change request holds the pull request whatever the case of either login", () => {
  assert.equal(jq(brake, [[review('Owner-Login', 'CHANGES_REQUESTED')]], 'owner-login'), 'CHANGES_REQUESTED');
  assert.equal(jq(brake, [[review('owner-login', 'CHANGES_REQUESTED')]], 'Owner-Login'), 'CHANGES_REQUESTED');
  assert.equal(jq(brake, [[review('someone-else', 'CHANGES_REQUESTED')]], 'owner-login'), '');
});

test("the owner's approval counts whatever the case of either login", () => {
  assert.equal(jq(approval, [[review('owner-login', 'APPROVED')]], 'Owner-Login'), 'APPROVED abc123');
  assert.equal(jq(approval, [[review('Owner-Login', 'APPROVED')]], 'owner-login'), 'APPROVED abc123');
  assert.equal(jq(approval, [[review('someone-else', 'APPROVED')]], 'owner-login'), '');
});

test("the owner's pushes count whatever the case of either login", () => {
  const push = login => ({actor: login === null ? null : {login}, activity_type: 'push', timestamp: '2026-10-26T00:00:00Z', after: 'def456'});
  assert.equal(jq(pushes, [[push('Owner-Login')]], 'owner-login'), 'def456');
  assert.equal(jq(pushes, [[push('someone-else')]], 'owner-login'), '');
  assert.equal(jq(pushes, [[push(null)]], 'owner-login'), '');
});

test('a review by a deleted account, which GitHub gives no user, matches no owner and stops nothing', () => {
  assert.equal(jq(brake, [[review(null, 'CHANGES_REQUESTED')]], 'owner-login'), '');
  assert.equal(jq(approval, [[review(null, 'APPROVED')]], 'owner-login'), '');
});

test("the owner's own pull request is recognized whatever the case of either login", () => {
  const author = (pullRequestAuthor, owner) => spawnSync('bash', ['-c', authorCheck],
    {env: {PULL_REQUEST_AUTHOR: pullRequestAuthor, OWNER: owner}}).status;
  assert.equal(author('Owner-Login', 'owner-login'), 0);
  assert.equal(author('owner-login', 'Owner-Login'), 0);
  assert.notEqual(author('someone-else', 'owner-login'), 0);
});

// A function the workflow's gate step defines, as its text: from `name() {` to its closing brace.
const shellFunction = name => workflow.match(new RegExp(`^ {10}${name}\\(\\) \\{\\n[\\s\\S]*?^ {10}\\}$`, 'm'))?.[0];
const sameChanges = ['changes', 'same_changes'].map(shellFunction);
const headChanges = workflow.match(/^ {10}(head_changes=.*)$/m)?.[1];

test("an earlier approval carries over only to byte-identical changes, not to the same edit made elsewhere in the file", t => {
  assert.ok(sameChanges.every(Boolean) && headChanges);
  const {dir, git, commit} = gitRepo(t, 'risk-tier-workflow');
  const block = 'a\nb\nc\nd\ne\nf\n';
  const base = commit({'f.txt': `${block}${'x\n'.repeat(5)}${block}`}, '-m', 'base');
  const approved = commit({'f.txt': `${block.replace('c', 'C')}${'x\n'.repeat(5)}${block}`}, '-m', 'first block');
  git('checkout', '-q', '--detach', base);
  const moved = commit({'f.txt': `${block}${'x\n'.repeat(5)}${block.replace('c', 'C')}`}, '-m', 'second block');
  git('checkout', '-q', '--detach', base);
  const main = commit({'other.txt': 'main moved on\n'}, '-m', 'main');
  git('merge', '-q', '--no-edit', approved);
  const updated = git('rev-parse', 'HEAD');
  const same = head => spawnSync('bash', ['-c', `${sameChanges.join('\n')}\n${headChanges}\nsame_changes "$APPROVED"`],
    {cwd: dir, env: {...gitEnv, BASE: main, HEAD_SHA: head, APPROVED: approved}}).status;
  assert.equal(same(moved), 1, 'the same edit to the other block is a different change');
  assert.equal(same(updated), 0, 'a merge of an unrelated main change leaves the changes the same');
  assert.equal(same(main), 1, 'no changes at all is not the approved change');
});

test('a pass on a head commit that another open pull request shares is posted as a failure', t => {
  const functions = ['sole_pull_request', 'status'].map(shellFunction);
  assert.ok(functions.every(Boolean));
  const {root} = gitRepo(t, 'risk-tier-workflow');
  const posted = join(root, 'posted');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // gh: the pull requests at the commit come from $PULLS ("fail" fails the lookup); a status post is recorded.
  writeFileSync(join(bin, 'gh'), `#!/bin/bash
case "$*" in
  *"/commits/"*"/pulls"*) [ "$PULLS" != fail ] || exit 1; printf '%s' "$PULLS" ;;
  *"/statuses/"*) printf '%s\\n' "$*" >> '${posted}' ;;
esac
`, {mode: 0o755});
  const run = (pulls, state = 'success') => {
    rmSync(posted, {force: true});
    spawnSync('bash', ['-c', `${functions.join('\n')}\nstatus ${state} "Auto tier: no approval needed"`], {env: {
      ...gitEnv, PATH: `${bin}:${process.env.PATH}`, PULLS: pulls, REPOSITORY: 'o/r', HEAD_SHA: 'h1',
      PULL_REQUEST_NUMBER: '5', RUN_URL: 'u', GITHUB_STEP_SUMMARY: '/dev/null'}});
    return readFileSync(posted, 'utf8').match(/state=(\w+)/)[1];
  };
  const pull = (number, sha = 'h1', state = 'open') => ({number, state, head: {sha}});
  assert.equal(run(JSON.stringify([[pull(5)]])), 'success');
  assert.equal(run(JSON.stringify([[pull(5), pull(6, 'h2'), pull(7, 'h1', 'closed')]])), 'success');
  assert.equal(run(JSON.stringify([[pull(5)], [pull(6)]])), 'failure', 'another open pull request at the head');
  assert.equal(run('fail'), 'failure', 'a failed lookup');
  assert.equal(run(JSON.stringify([[pull(5), pull(6)]]), 'pending'), 'pending', 'only a pass is refused');
});
