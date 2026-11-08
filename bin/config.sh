# shellcheck shell=bash
# Sourced by Triphammer's bash scripts; the grammar and the checks are in bin/README.md ("Configuration").
# It is the Triphammer config's one reader: bin/demo-publish, bin/demo-gallery and status/config.mjs
# run it as a command:
#
#   bash config.sh --print <script name> <checkout> [--module <name> [<setting>...] --] <KEY>...
#
# runs load_config <script name> <checkout>, then, with --module, module_needs <script name> <name> <setting>...,
# and prints each KEY's value followed by NUL: Bash variables cannot hold NUL, so NUL separates the values whatever
# they contain. A KEY is REPO, CHECKOUT, APP_AUTHOR, STATE_DIR, PROJECT or an optional setting, which prints empty
# when the config leaves it out. Any failure prints its message, prefixed with the script name, and exits 2.
#
# load_config <script name> <checkout the script lives in>: reads Triphammer's settings into cfg_repo, cfg_checkout,
# cfg_app_author and cfg_state_dir, every setting the file gives into the associative array cfg, the modules it turns
# on into cfg_modules (separated by spaces), the file's path into cfg_file, the project's name into cfg_project and the
# shared directory every project shares into cfg_shared_dir, or prints which file and which setting is wrong and exits 2.
# The file is $TRIPHAMMER_CONFIG when that is set, else ${XDG_CONFIG_HOME:-~/.config}/triphammer/<name>.conf, where
# <name> is $TRIPHAMMER_PROJECT when that is set (the template units set it to their instance name), else the `name` in
# the .triphammer/project.json of the checkout the script lives in. The project's name is $TRIPHAMMER_PROJECT when that
# is set, else the file's name without `.conf`. The shared directory is $TRIPHAMMER_SHARED_DIR when that is set, else
# ${XDG_STATE_HOME:-~/.local/state}/triphammer.
#
# module_on <module>: succeeds when the config turns the module on. module_needs <script name> <module>
# [<setting>...]: prints why and exits 2 when the module is off or the config leaves one of the settings out, and
# says that triphammer update writes the default of one that has a default (codex_defaults below).
#
# check_project <script name> <checkout>: checks <checkout>/.triphammer/project.json, the project's data, or prints what
# is wrong with it and returns 2. project_get <checkout> <field>: prints a string or boolean field of that file, or
# each element of an array field on its own line, or nothing when the project does not declare it (an object field,
# such as checks, is read with jq instead).
#
# same_repo <dir> <dir>: succeeds when both directories are in one git repository (one common git directory), as a
# project whose CHECKOUT is Triphammer's own checkout, or a worktree of it, is, or when one is a run's clone of the
# other (ticket-runner's add_clone), whose objects/info/alternates names the other's objects.
#
# machine_path: prints the machine file's path, ${TRIPHAMMER_PROVISION_ROOT}/etc/triphammer.conf (bin/provision and
# bin/provision-project write it, one KEY=VALUE per line; bin/provision-lib.sh). TRIPHAMMER_PROVISION_ROOT is for tests
# only, as in provision. bin/triphammer, which root runs and which does not source this file, names it on its own.
machine_path() {
  printf '%s\n' "${TRIPHAMMER_PROVISION_ROOT:-}/etc/triphammer.conf"
}
# machine_get <KEY>: prints the value the machine file (machine_path) gives KEY, as it stands after the `=`, from the
# last line that gives it, or nothing when the file is missing or unreadable or gives no KEY. It checks no value: each
# caller checks its own.
machine_get() {
  local file line value=""
  file="$(machine_path)"
  [ -r "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" != "$1="* ]] || value="${line#*=}"
  done < "$file"
  printf '%s' "$value"
}

# Each project that declares "docker": true has a rootless Docker daemon of its own, which bin/provision-project sets
# up and names in the machine file under two keys that end in the project's docker_key: TRIPHAMMER_DOCKER_USER_<key>,
# its user, and TRIPHAMMER_DOCKER_SOCKET_<key>, the absolute path of its socket.
#
# docker_key <project>: prints the project's name in capitals with each - made _ (example-project gives
# EXAMPLE_PROJECT), or fails for a name of anything but lower-case letters, digits and dashes, starting with a letter
# or a digit: those are the names no other name maps onto.
docker_key() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]] || return 1
  local key="${1^^}"
  printf '%s\n' "${key//-/_}"
}
# plain_socket <path>: succeeds for an absolute path of the plain characters provision-project writes.
plain_socket() {
  [[ "$1" =~ ^(/[A-Za-z0-9._-]+)+$ && "$1/" != */./* && "$1/" != */../* ]]
}
# rootless_docker_host <project>: prints unix://<path> for the socket of the project's own rootless Docker daemon
# (machine_get TRIPHAMMER_DOCKER_SOCKET_<key>), or nothing when the project's name has no key or the machine file is
# missing or names no plain absolute path (plain_socket) for it.
rootless_docker_host() {
  local key socket
  key="$(docker_key "$1")" || return 0
  socket="$(machine_get "TRIPHAMMER_DOCKER_SOCKET_$key")"
  plain_socket "$socket" || return 0
  printf 'unix://%s\n' "$socket"
}
# rootless_docker_sockets: prints, one per line, the socket of every rootless Docker daemon the machine file names
# (machine_get TRIPHAMMER_DOCKER_SOCKET_<key> for each key it gives), each only when it is a plain absolute path.
rootless_docker_sockets() {
  local file line key socket
  local -A seen=()
  file="$(machine_path)"
  [ -r "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^(TRIPHAMMER_DOCKER_SOCKET_[A-Z0-9_]+)= ]] || continue
    key="${BASH_REMATCH[1]}"
    [ -z "${seen[$key]:-}" ] || continue
    seen[$key]=1
    socket="$(machine_get "$key")"
    ! plain_socket "$socket" || printf '%s\n' "$socket"
  done < "$file"
}
# The directories of a rootless Docker daemon's user's home that root owns with mode 755, from the home (.) down, each
# followed by the only entries it may hold: provision-project makes them (docker_home in bin/provision-lib.sh) and the
# doctor checks them (docker_home_problem).
# shellcheck disable=SC2034  # read by the scripts that source this file
docker_home_shape=(
  ". .config .local"
  ".config systemd"
  ".config/systemd user"
  ".config/systemd/user docker.service default.target.wants"
  ".config/systemd/user/default.target.wants docker.service"
  ".local share"
  ".local/share docker"
)

# How a project's checkout pins Playwright, for provision-project, which installs its Chromium, and the doctor, which
# checks for it: each file `git ls-files -- "$playwright_manifests"` lists in the checkout names the version it asks
# for under the jq filter $playwright_filter, which prints nothing when the file asks for no Playwright.
# shellcheck disable=SC2034  # read by the scripts that source this file
playwright_manifests='*package.json'
# shellcheck disable=SC2034  # read by the scripts that source this file
playwright_filter='(.devDependencies // {}) + (.dependencies // {}) | .["@playwright/test"] // .playwright // empty'

# The optional modules, and every setting a Triphammer config may give besides the four required ones.
known_modules=(demo qwen-audit codex)
optional_settings=(OWNER MODULES STATUS_HOST STATUS_PORT STATUS_ALLOWED_HOSTS DEMO_GALLERY_DIR DEMO_URL
  DEMO_GALLERY_HOST DEMO_GALLERY_PORT QWEN_BASE_URL QWEN_KEY_FILE QWEN_MODEL CODEX_AUDIT_MODEL CODEX_SECURITY_MODEL
  CODEX_WEEKLY_CAP CODEX_FLOOR_PERCENT CODEX_RUN_PERCENT)
# The codex module's defaults: provision-project writes each one into a config that turns the module on without it,
# and local-audit falls back to the limits' for a config without them.
# shellcheck disable=SC2034  # read by the scripts that source this file
declare -gA codex_defaults=([CODEX_SECURITY_MODEL]=gpt-daybreak-blue-latest [CODEX_AUDIT_MODEL]=gpt-6.1-sol
  [CODEX_WEEKLY_CAP]=500 [CODEX_FLOOR_PERCENT]=0 [CODEX_RUN_PERCENT]=1)

load_config() {
  local script="$1" own="$2" file name line n=0 key value module pattern
  local -A found=() seen=()
  if [ -n "${TRIPHAMMER_PROJECT:-}" ] && ! [[ "$TRIPHAMMER_PROJECT" =~ ^[A-Za-z0-9_-][A-Za-z0-9._-]*$ ]]; then
    echo "$script: TRIPHAMMER_PROJECT must be a project name (letters, digits, dots, dashes or underscores, not starting with a dot), not $TRIPHAMMER_PROJECT" >&2
    exit 2
  fi
  if [ -n "${TRIPHAMMER_CONFIG:-}" ]; then
    file="$TRIPHAMMER_CONFIG"
  elif [ -n "${TRIPHAMMER_PROJECT:-}" ]; then
    file="${XDG_CONFIG_HOME:-$HOME/.config}/triphammer/$TRIPHAMMER_PROJECT.conf"
  else
    check_project "$script" "$own" || exit 2
    name="$(project_get "$own" name)"
    file="${XDG_CONFIG_HOME:-$HOME/.config}/triphammer/$name.conf"
  fi
  if [ ! -f "$file" ] || [ ! -r "$file" ]; then
    echo "$script: the Triphammer config $file is missing or unreadable; create it with REPO, CHECKOUT, APP_AUTHOR and STATE_DIR (bin/README.md)" >&2
    exit 2
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
    if ! [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      echo "$script: $file line $n is not KEY=value" >&2
      exit 2
    fi
    key="${BASH_REMATCH[1]}" value="${BASH_REMATCH[2]}"
    if [[ " REPO CHECKOUT APP_AUTHOR STATE_DIR ${optional_settings[*]} " != *" $key "* ]]; then
      echo "$script: $file line $n sets $key, which is not a config setting" >&2
      exit 2
    fi
    if [ -n "${found[$key]+set}" ]; then
      echo "$script: $file line $n sets $key a second time" >&2
      exit 2
    fi
    found[$key]="$value"
  done < "$file"
  for key in REPO CHECKOUT APP_AUTHOR STATE_DIR; do
    if [ -z "${found[$key]:-}" ]; then
      echo "$script: $file does not set $key" >&2
      exit 2
    fi
  done
  if ! [[ "${found[REPO]}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "$script: $file: REPO must be owner/name, not ${found[REPO]}" >&2
    exit 2
  fi
  for key in CHECKOUT STATE_DIR; do
    if [[ "${found[$key]}" != /* ]]; then
      echo "$script: $file: $key must be an absolute path, not ${found[$key]}" >&2
      exit 2
    fi
  done
  if [[ "${found[APP_AUTHOR]}" =~ [[:space:]] ]]; then
    echo "$script: $file: APP_AUTHOR must be one login, not ${found[APP_AUTHOR]}" >&2
    exit 2
  fi
  # The optional settings are checked only when given; a module that needs one checks for it (module_needs).
  # A GitHub login: letters, digits and single dashes between them, at most 39 characters.
  if [ -n "${found[OWNER]:-}" ] && { ! [[ "${found[OWNER]}" =~ ^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$ ]] || [ "${#found[OWNER]}" -gt 39 ]; }; then
    echo "$script: $file: OWNER must be one GitHub login (letters, digits and single dashes between them, at most 39 characters), not ${found[OWNER]}" >&2
    exit 2
  fi
  if [ -n "${found[MODULES]:-}" ]; then
    if ! [[ "${found[MODULES]}" =~ ^[a-z-]+(,[a-z-]+)*$ ]]; then
      echo "$script: $file: MODULES must be module names separated by commas, not ${found[MODULES]}" >&2
      exit 2
    fi
    for module in ${found[MODULES]//,/ }; do
      if [[ " ${known_modules[*]} " != *" $module "* ]]; then
        echo "$script: $file: MODULES names $module, which is not a module (${known_modules[*]})" >&2
        exit 2
      fi
      if [ -n "${seen[$module]:-}" ]; then
        echo "$script: $file: MODULES names $module twice" >&2
        exit 2
      fi
      seen[$module]=1
    done
  fi
  for key in DEMO_GALLERY_DIR QWEN_KEY_FILE; do
    if [ -n "${found[$key]:-}" ] && [[ "${found[$key]}" != /* ]]; then
      echo "$script: $file: $key must be an absolute path, not ${found[$key]}" >&2
      exit 2
    fi
  done
  for key in DEMO_URL QWEN_BASE_URL; do
    if [ -n "${found[$key]:-}" ] && ! [[ "${found[$key]}" =~ ^https?://[^[:space:]]+$ ]]; then
      echo "$script: $file: $key must be an http or https URL, not ${found[$key]}" >&2
      exit 2
    fi
  done
  for key in STATUS_HOST DEMO_GALLERY_HOST; do
    if [ -n "${found[$key]:-}" ] && ! [[ "${found[$key]}" =~ ^[A-Za-z0-9._:-]+$ ]]; then
      echo "$script: $file: $key must be an address or host name (letters, digits and ._:-), not ${found[$key]}" >&2
      exit 2
    fi
  done
  for key in STATUS_PORT DEMO_GALLERY_PORT; do
    if [ -n "${found[$key]:-}" ] && { ! [[ "${found[$key]}" =~ ^[0-9]{1,5}$ ]] \
        || [ "$((10#${found[$key]}))" -lt 1 ] || [ "$((10#${found[$key]}))" -gt 65535 ]; }; then
      echo "$script: $file: $key must be a port from 1 to 65535, not ${found[$key]}" >&2
      exit 2
    fi
  done
  # Brackets are allowed for IPv6 addresses; a ] must come first in a bracket expression, so the pattern is a variable.
  pattern='^[][A-Za-z0-9._:-]+(,[][A-Za-z0-9._:-]+)*$'
  if [ -n "${found[STATUS_ALLOWED_HOSTS]:-}" ] && ! [[ "${found[STATUS_ALLOWED_HOSTS]}" =~ $pattern ]]; then
    echo "$script: $file: STATUS_ALLOWED_HOSTS must be host names separated by commas, no blanks, not ${found[STATUS_ALLOWED_HOSTS]}" >&2
    exit 2
  fi
  for key in QWEN_MODEL CODEX_AUDIT_MODEL CODEX_SECURITY_MODEL; do
    if [ -n "${found[$key]:-}" ] && ! [[ "${found[$key]}" =~ ^[A-Za-z0-9._:/-]+$ ]]; then
      echo "$script: $file: $key must be a model name, not ${found[$key]}" >&2
      exit 2
    fi
  done
  # No leading zero: the scripts do arithmetic with these, which reads 08 as octal.
  for key in CODEX_WEEKLY_CAP CODEX_FLOOR_PERCENT CODEX_RUN_PERCENT; do
    if [ -n "${found[$key]:-}" ] && { ! [[ "${found[$key]}" =~ ^(0|[1-9][0-9]{0,5})$ ]] \
        || { [ "$key" != CODEX_WEEKLY_CAP ] && [ "${found[$key]}" -gt 100 ]; }; }; then
      echo "$script: $file: $key must be a whole number$([ "$key" = CODEX_WEEKLY_CAP ] || echo ' from 0 to 100'), not ${found[$key]}" >&2
      exit 2
    fi
  done
  module="${found[MODULES]:-}"
  declare -gA cfg=()
  for key in "${!found[@]}"; do cfg[$key]="${found[$key]}"; done
  # shellcheck disable=SC2034  # read by the scripts that source this file
  cfg_repo="${found[REPO]}" cfg_checkout="${found[CHECKOUT]}" cfg_app_author="${found[APP_AUTHOR]}" \
    cfg_state_dir="${found[STATE_DIR]}" cfg_modules="${module//,/ }" cfg_file="$file"
  name="${file##*/}"
  # shellcheck disable=SC2034  # read by the scripts that source this file
  cfg_project="${TRIPHAMMER_PROJECT:-${name%.conf}}" cfg_shared_dir="${TRIPHAMMER_SHARED_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/triphammer}"
}

module_on() {
  [[ " $cfg_modules " == *" $1 "* ]]
}

module_needs() {
  local script="$1" module="$2" key
  shift 2
  if ! module_on "$module"; then
    echo "$script: the $module module is off; add it to MODULES in $cfg_file (bin/README.md)" >&2
    exit 2
  fi
  for key in "$@"; do
    if [ -z "${cfg[$key]:-}" ]; then
      echo "$script: $cfg_file: the $module module needs $key${codex_defaults[$key]+; triphammer update writes its default}" >&2
      exit 2
    fi
  done
}

check_project() {
  local script="$1" file="$2/.triphammer/project.json" problem key pattern status
  if [ ! -f "$file" ]; then
    echo "$script: the project file $file is missing" >&2
    return 2
  fi
  problem="$(jq -r '
    def strings: type == "array" and length > 0 and all(.[]; type == "string" and length > 0 and (contains("\n") | not));
    def text: type == "string" and length > 0;
    . as $root | if type != "object" then "it is not a JSON object"
    else [
      (if (.name | type == "string" and test("^[A-Za-z0-9._-]+$")) then empty
       else "name must be letters, digits, dots, dashes or underscores" end),
      (if .worktreeTeardown == null or (.worktreeTeardown | strings and (.[0] | startswith("/") | not)) then empty
       else "worktreeTeardown must be a command: a list of words whose first is a path relative to the worktree" end),
      (("demos", "docker") as $key
        | if $root[$key] == null or ($root[$key] | type == "boolean") then empty else "\($key) must be true or false" end),
      (("composeProjectPattern", "securityReviewPaths", "securityReviewArea", "reviewChecklist", "uiVerificationSkill") as $key
        | if $root[$key] == null or ($root[$key] | text) then empty else "\($key) must be text" end),
      (if .reviewSkills == null or (.reviewSkills | strings) then empty else "reviewSkills must be a list of paths" end),
      (if .shellEditRoots == null or (.shellEditRoots | type == "array" and all(.[]; type == "string" and length > 0
          and (startswith("/") | not) and (rtrimstr("/") | split("/") | all(. != "" and . != "." and . != ".."))))
       then empty else "shellEditRoots must be a list of paths relative to the repository root, inside it" end),
      (if .checks == null or (.checks | type == "object" and length > 0) then empty else "checks must be an object" end),
      (.checks | if type == "object" then to_entries[] else empty end
        | if (.key | IN("build", "focused", "suite", "gate") | not) then "checks may name only build, focused, suite and gate, not \(.key)"
          elif (.value | type == "string" and test("^[A-Za-z0-9._/:=@+,<>-]+( [A-Za-z0-9._/:=@+,<>-]+)*$") | not)
          then "checks.\(.key) must be a command: words of letters, digits and ._/:=@+,<>- separated by single spaces"
          # local-audit allows a command with a placeholder as its text up to the first "<" plus anything, so a
          # placeholder in the first word would allow commands the check never names, and one alone any command.
          elif (.value | test("^[^ <]+( |$)") | not) then "checks.\(.key) must start with a command word, not a <placeholder>"
          else empty end)
    ] | first // empty end' "$file" 2>/dev/null)" || problem="it is not valid JSON"
  for key in composeProjectPattern securityReviewPaths; do
    [ -z "$problem" ] || break
    pattern="$(project_get "$2" "$key")"
    # [[ =~ ]] returns 2 for a pattern that does not compile, and 0 or 1 otherwise.
    status=0
    # shellcheck disable=SC2319  # the status of the match itself is the point
    [[ x =~ $pattern ]] || status=$?
    [ "$status" -ne 2 ] || problem="$key is not a valid extended regular expression"
  done
  if [ -n "$problem" ]; then
    echo "$script: the project file $file is malformed: $problem" >&2
    return 2
  fi
}

project_get() {
  jq -r --arg key "$2" '.[$key] // empty | if type == "array" then .[] else . end' "$1/.triphammer/project.json"
}

same_repo() {
  local a b from to line
  a="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  b="$(git -C "$2" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  a="$(readlink -f "$a")" b="$(readlink -f "$b")"
  [ "$a" != "$b" ] || return 0
  for from in "$a" "$b"; do
    to="$a"
    [ "$from" != "$a" ] || to="$b"
    [ -f "$from/objects/info/alternates" ] || continue
    while IFS= read -r line; do
      [[ "$line" == /* ]] || line="$from/objects/$line"
      [ "$(readlink -f "$line")" != "$to/objects" ] || return 0
    done < "$from/objects/info/alternates"
  done
  return 1
}

# The command mode (see the top of the file); sourcing the file only defines the functions.
config_print() {
  local script="${2:-config.sh}" own key module=""
  local -a needs=()
  local usage="usage: bash config.sh --print <script name> <checkout> [--module <name> [<setting>...] --] <KEY>..."
  if [ "${1:-}" != --print ] || [ $# -lt 4 ] || [ -z "$2" ]; then
    echo "$script: $usage" >&2
    exit 2
  fi
  own="$3"
  shift 3
  if [ "$1" = --module ]; then
    module="${2:-}"
    [ -n "$module" ] || { echo "$script: $usage" >&2; exit 2; }
    shift 2
    while [ $# -gt 0 ] && [ "$1" != -- ]; do needs+=("$1"); shift; done
    shift # the --; without one no KEY is left and the check below stops
  fi
  [ $# -gt 0 ] || { echo "$script: $usage" >&2; exit 2; }
  for key in "${needs[@]}"; do
    if [[ " ${optional_settings[*]} " != *" $key "* ]]; then
      echo "$script: $key is not an optional config setting; $usage" >&2
      exit 2
    fi
  done
  for key in "$@"; do
    if [[ " REPO CHECKOUT APP_AUTHOR STATE_DIR PROJECT ${optional_settings[*]} " != *" $key "* ]]; then
      echo "$script: $key is not a config setting; $usage" >&2
      exit 2
    fi
  done
  load_config "$script" "$own"
  [ -z "$module" ] || module_needs "$script" "$module" "${needs[@]}"
  # cfg holds every setting the file gives, the four required ones included.
  for key in "$@"; do
    if [ "$key" = PROJECT ]; then printf '%s\0' "$cfg_project"; else printf '%s\0' "${cfg[$key]:-}"; fi
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  config_print "$@"
fi
