# shellcheck shell=bash
# The labels Triphammer reads and sets in a project's repository: the owner's brakes and priority, which the owner
# applies, the runner's `agent-working`, and `cleanup`, which the runner puts on the issues it files from a session's
# proposals. `ticket-runner --labels` (which `triphammer add` runs as the service
# user) creates the ones the repository lacks with create_labels, and the doctor reports them with missing_labels, so
# both read this one list. bin/README.md ("Labels") lists what each does. `upkeep` is not here: ticket-runner makes
# sure it exists when it opens an upkeep issue.
#
# Each entry: name|color|description. GitHub limits a description to 100 characters.
triphammer_labels=(
  "hold|D93F0B|The owner's brake: Triphammer skips this issue or pull request and stops a run on it"
  "needs-owner|5319E7|Waits for the owner: Triphammer neither runs nor merges it while this label is on"
  "stop-agents|B60205|An open issue with this label pauses Triphammer in this repository"
  "next|0E8A16|Triphammer takes this ready issue before the other ready issues"
  "agent-working|FBCA04|Triphammer is working on this; don't update or push to it"
  "light|C2E0C6|Triphammer's first run on this issue uses the Sonnet builder; later runs use Opus"
  "cleanup|BFD4F2|A cleanup a session proposed; Triphammer takes it after the other ready issues"
)

# $labelled_jq: a jq prelude defining labelled($name), true when the input's labels include $name, given in lowercase,
# in any case, as GitHub matches label names. It reads both shapes the scripts get: `.labels[].name` (gh --json) and
# `.labels.nodes[].name` (GraphQL). ticket-runner and merge-when-ready prefix their label filters with it:
# --jq "$labelled_jq"'labelled("hold")'. It also defines labels_unread, true when the input's `.labels` (the gh --json
# shape) holds 100 labels or more: gh reads only the first 100 and says nothing of the rest, so a brake may be among them.
# It must stay at 100, the most gh returns. bin/ticket-decide.py's UNREAD is one lower and leaves out agent-working, as
# the runner adds that label before its first brake check: an item picked at 99 would be braked here on every tick.
# shellcheck disable=SC2034,SC2016  # read by the scripts that source this file; the $ is jq's
labelled_jq='def labelled($name): any((.labels | if type == "object" then .nodes else . end)[]?; .name | ascii_downcase == $name);
  def labels_unread: (.labels | length) >= 100; '

# missing_labels <owner/repo>: prints the name of each label of triphammer_labels the repository lacks, one per line,
# comparing names case-insensitively as GitHub does. Fails, printing nothing, when the labels cannot be listed.
missing_labels() {
  local have entry name missing=""
  have="$(gh label list -R "$1" --limit 1000 --json name --jq '.[].name')" || return 1
  for entry in "${triphammer_labels[@]}"; do
    name="${entry%%|*}"
    grep -qixF -- "$name" <<< "$have" || missing+="$name"$'\n'
  done
  printf '%s' "$missing"
}

# create_labels <owner/repo>: creates each label of triphammer_labels the repository lacks, with its color and
# description, and leaves the ones it has as they are (no --force). Prints a line per label created and fails, after
# trying every one, when the labels cannot be listed or one cannot be created.
create_labels() {
  local missing entry name rest color description status=0
  if ! missing="$(missing_labels "$1")"; then
    echo "could not list the labels of $1" >&2
    return 1
  fi
  for entry in "${triphammer_labels[@]}"; do
    name="${entry%%|*}" rest="${entry#*|}"
    color="${rest%%|*}" description="${rest#*|}"
    grep -qxF -- "$name" <<< "$missing" || continue
    if gh label create "$name" -R "$1" --color "$color" --description "$description" >/dev/null; then
      echo "created the label $name in $1"
    else
      echo "could not create the label $name in $1" >&2
      status=1
    fi
  done
  return "$status"
}

# The owner's brakes outlive their labels and the issue's state: a session acts with the App's token, so whatever the
# App sets brakes only while it is there, and whatever the App lifts stays on. This is best effort: a brake the App
# lifts is not a finding (bin/security-review-brief.md, Not findings). The functions below read who did what from the
# issue events API, where the App acts as <name>[bot]; each caller sets $app_login to that login (event_login).

# event_login <app-author>: the App's login in the events API, from APP_AUTHOR: app/<name> acts as <name>[bot], and any
# other author as itself.
event_login() {
  if [[ "${1,,}" == app/* ]]; then echo "${1:4}[bot]"; else echo "$1"; fi  # case-sensitive: lowered, against a lowercase literal
}

# brake_events <owner/repo> <number>: the labeled, unlabeled, closed and reopened events of issue or pull request
# <number>, oldest first, one per line: "<event> <login> <label name, lowercased>". Fails when they cannot be read.
brake_events() {
  gh api "repos/$1/issues/$2/events" --paginate --jq '.[]
    | select(.event == "labeled" or .event == "unlabeled" or .event == "closed" or .event == "reopened")
    | "\(.event) \(.actor.login // "-") \(.label.name // "" | ascii_downcase)"' 2>/dev/null
}

# owner_brake <owner/repo> <number> <brake>...: whether each brake named holds issue or pull request <number> of
# <owner/repo>, from its events (oldest first), whatever its labels and state are now. A brake is a label name, given
# in lowercase, whose `labeled` and `unlabeled` events count, or `closed`, whose `closed` and `reopened` events count.
# Prints, for each brake in order and separated by spaces, "on" when the last of its events by anyone but the App sets
# it (labeled, closed), "off" when that one lifts it or the App's are its only ones, and "none" when it has no event.
# Label names and logins compare case-insensitively. Fails, printing nothing, when the events cannot be read.
# Each brake is judged from its own events alone: combining two brakes' states loses their order.
# shellcheck disable=SC2154  # app_login is the caller's
owner_brake() {
  local repository="$1" number="$2" events event actor name i
  shift 2
  local -a asked=("$@") states=()
  for i in "${!asked[@]}"; do states[i]=none; done
  events="$(brake_events "$repository" "$number")" || return 1
  while read -r event actor name; do
    [ -n "$event" ] || continue
    for i in "${!asked[@]}"; do
      if [ "${asked[i]}" = closed ]; then
        [ "$event" = closed ] || [ "$event" = reopened ] || continue
      elif { [ "$event" != labeled ] && [ "$event" != unlabeled ]; } || [ "$name" != "${asked[i]}" ]; then
        continue
      fi
      [ "${states[i]}" != none ] || states[i]=off
      [ "${actor,,}" != "${app_login,,}" ] || continue
      case "$event" in labeled|closed) states[i]=on ;; *) states[i]=off ;; esac
    done
  done <<< "$events"
  echo "${states[*]}"
}

# owner_stop_agents <owner/repo> <record>: prints, separated by spaces, the issues of <owner/repo> that the owner's
# stop-agents holds, whatever their labels and state are now: each one that someone other than the App labelled
# stop-agents and did not unlabel or close afterwards, judged from its events (brake_events) in order, so a close
# before the label lifts nothing, and a reopening by someone other than the App while their label is on holds again.
# The App's unlabelling, closing or reopening counts for nothing. The candidates are the issues labelled stop-agents
# now, in any state, and those with a `labeled` stop-agents event by someone other than the App or an `unlabeled` one
# by anyone in the repository's issue events, which GitHub lists newest first. <record>, a file only the caller writes,
# keeps them between calls after a first line with the time of the newest event read, so a call reads the events back
# to an hour before that time (pages of 100 until a short one or one that reaches it), and the whole list when the
# record is missing or malformed, up to the 300th page, the last one GitHub serves. Past it, an owner's stop-agents
# whose label is off now is missed unless its `unlabeled` event is among the events read. A candidate whose
# stop-agents someone other than the App removed leaves the record, and a later label brings it back. Fails, printing
# nothing, when a read fails, so the caller brakes; an issue whose events cannot be read, a deleted one too, fails
# every call until its line leaves the record.
owner_stop_agents() {
  local repository="$1" record="$2" mark="" cutoff="" newest="" candidates="" kept="" paused="" failed="" page=1
  local events count oldest at number event actor name n out label held
  if [ -f "$record" ] && { read -r mark < "$record"; } 2>/dev/null \
      && [[ "$mark" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
    candidates="$(tail -n +2 "$record")"
    cutoff="$(date -u -d "@$(( $(date -u -d "$mark" +%s) - 3600 ))" +%Y-%m-%dT%H:%M:%SZ)"
    newest="$mark"
  fi
  candidates+=$'\n'"$(gh issue list -R "$repository" --label stop-agents --state all --limit 1000 --json number \
    --jq '.[].number' 2>/dev/null)" || return 1
  while :; do
    events="$(gh api "repos/$repository/issues/events?per_page=100&page=$page" --jq '.[]
      | "\(.created_at) \(.issue.number // 0) \(.event) \(.actor.login // "-") \(.label.name // "" | ascii_downcase)"' \
      2>/dev/null)" || return 1
    count=0 oldest=""
    while read -r at number event actor name; do
      [ -n "$at" ] || continue
      count=$((count + 1)) oldest="$at"
      [[ "$at" < "$newest" ]] || newest="$at"
      if [ "$name" = stop-agents ] && { [ "$event" = unlabeled ] \
          || { [ "$event" = labeled ] && [ "${actor,,}" != "${app_login,,}" ]; }; }; then
        candidates+=$'\n'"$number"
      fi
    done <<< "$events"
    if [ "$count" -lt 100 ] || [ "$page" -ge 300 ] || { [ -n "$cutoff" ] && [[ "$oldest" < "$cutoff" ]]; }; then
      break
    fi
    page=$((page + 1))
  done
  candidates="$(grep -xE '[1-9][0-9]*' <<< "$candidates" | sort -nu || true)"
  for n in $candidates; do
    if ! out="$(brake_events "$repository" "$n")"; then
      failed=1 kept="$candidates"$'\n'
      break
    fi
    label=none held=""
    while read -r event actor name; do
      if [ "$event" = closed ] || [ "$event" = reopened ]; then
        [ "${actor,,}" != "${app_login,,}" ] || continue
        if [ "$event" = closed ]; then held=""; elif [ "$label" = on ]; then held=1; fi
      elif [ "$name" = stop-agents ]; then
        [ "$label" != none ] || label=off
        [ "${actor,,}" != "${app_login,,}" ] || continue
        if [ "$event" = labeled ]; then label=on held=1; else label=off held=""; fi
      fi
    done <<< "$out"
    [ "$label" = off ] || kept+="$n"$'\n'
    [ -z "$held" ] || paused+="$n "
  done
  if [ -n "$newest" ]; then
    { printf '%s\n%s' "$newest" "$kept" > "$record.$BASHPID" && mv -f "$record.$BASHPID" "$record"; } 2>/dev/null || true
  fi
  [ -z "$failed" ] || return 1
  printf '%s' "${paused% }"
}
