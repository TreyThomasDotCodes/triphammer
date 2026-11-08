# shellcheck shell=bash
# What bin/provision and bin/provision-project share, sourced by both after they define `prog` (their name, for
# messages), `here` (their directory) and `usage`, and before they set `user`, `home` and `dry_run`. Nothing here
# changes the machine until a script calls it.
# shellcheck disable=SC2154  # prog, here, user, home and dry_run are the sourcing script's
# shellcheck disable=SC2034  # codename, arch, node_arch and node_bin are for the sourcing script
# shellcheck disable=SC2016  # the sh -c scripts expand their own arguments, not this shell's
#
# The machine file, $root/etc/triphammer.conf, is how provision-project, the triphammer command and the service user's
# scripts find what provision set up: Triphammer's repository and checkout (TRIPHAMMER_REPO, TRIPHAMMER_CHECKOUT) and
# the service user and its home (TRIPHAMMER_USER, TRIPHAMMER_HOME), which provision writes, and, for each project that
# declares "docker": true, its own rootless Docker daemon's user and the absolute path of its socket
# (TRIPHAMMER_DOCKER_USER_<key>, TRIPHAMMER_DOCKER_SOCKET_<key>, with docker_key in config.sh), which provision-project
# writes. Both write it as root, mode 644, one KEY=VALUE per line, and each keeps every line it does not set
# (machine_with).
#
# Tests run the scripts with fakes of the package and account tools first on PATH, and two variables meant for them
# only: TRIPHAMMER_PROVISION_ROOT, a directory the system paths the scripts write (/etc, /usr/local, /tmp) and read
# (/etc/os-release) are taken under, and TRIPHAMMER_PROVISION_GIT_BASE, the URL the repositories are cloned under
# instead of https://github.com/.

usage_error() {
  printf '%s: %s\n' "$prog" "$1" >&2
  usage
  exit 2
}
fail() {
  printf '%s: %s\n' "$prog" "$1" >&2
  exit 1
}

root="${TRIPHAMMER_PROVISION_ROOT:-}"
git_base="${TRIPHAMMER_PROVISION_GIT_BASE:-https://github.com/}"
repo_pattern='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
node_bin="$root/usr/local/bin"
# shellcheck source=bin/config.sh
source "$here/config.sh"  # machine_path, machine_get
machine_file="$(machine_path)"

# check_place <flag> <repo> <path>: a repository as owner/name and a checkout as a plain absolute path, or exit 2.
check_place() {
  [[ "$2" =~ $repo_pattern ]] || usage_error "$1 takes a repository as owner/name, not $2"
  [[ "$3" == /* && "$3" != */ && "$3" != *//* && "/$3/" != */../* && "/$3/" != */./* ]] \
    || usage_error "$1 $2: the checkout must be an absolute path without . or .. parts or a trailing /, not $3"
}

# machine_with <KEY=VALUE>...: the machine file's content with each KEY given its VALUE, in the place of the first line
# that gives KEY, whose later lines are dropped, or else at the end, in the order given; every other line stays as it
# is. A missing or empty file starts with a line saying what it is.
machine_with() {
  local line key pair
  local -A want=() set=()
  for pair; do want[${pair%%=*}]="${pair#*=}"; done
  if [ -s "$machine_file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      key="${line%%=*}"
      if [[ "$line" =~ ^[A-Z][A-Z0-9_]*= && -n "${want[$key]+set}" ]]; then
        [ -z "${set[$key]:-}" ] || continue
        line="$key=${want[$key]}" set[$key]=1
      fi
      printf '%s\n' "$line"
    done < "$machine_file"
  else
    printf '# Written by bin/provision and bin/provision-project: Triphammer on this machine (bin/README.md, On a machine of its own).\n'
  fi
  for pair; do [ -n "${set[${pair%%=*}]:-}" ] || printf '%s\n' "$pair"; done
}
# read_machine: sets tri_repo, tri_checkout, user and home from the machine file, or exits 1 naming what is wrong.
read_machine() {
  [ -r "$machine_file" ] || fail "$machine_file is missing; set the machine up first (install.sh, or bin/provision)"
  tri_repo="$(machine_get TRIPHAMMER_REPO)" tri_checkout="$(machine_get TRIPHAMMER_CHECKOUT)"
  user="$(machine_get TRIPHAMMER_USER)" home="$(machine_get TRIPHAMMER_HOME)"
  [[ "$tri_repo" =~ $repo_pattern && "$tri_checkout" == /* && "$user" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$home" == /* ]] \
    || fail "$machine_file does not name Triphammer's repository, checkout, user and home; run bin/provision again"
}

# check_ubuntu: run as root on Ubuntu, amd64 or arm64; sets codename, arch and node_arch.
check_ubuntu() {
  [ "$(id -u)" = 0 ] || fail "run it as root (sudo $0 ...); --dry-run too, as it reads what only root may"
  [ -r "$root/etc/os-release" ] || fail "$root/etc/os-release is missing; $prog runs on Ubuntu"
  local os_id
  os_id="$(sed -n 's/^ID=//p' "$root/etc/os-release" | tr -d '"')"
  codename="$(sed -n 's/^VERSION_CODENAME=//p' "$root/etc/os-release" | tr -d '"')"
  [ "$os_id" = ubuntu ] || fail "this is ${os_id:-an unknown system}, not Ubuntu; $prog runs on Ubuntu"
  [[ "$codename" =~ ^[a-z]+$ ]] || fail "$root/etc/os-release names no release (VERSION_CODENAME)"
  arch="$(dpkg --print-architecture)"
  case "$arch" in
    amd64) node_arch=x64 ;;
    arm64) node_arch=arm64 ;;
    *) fail "the machine's architecture is $arch; $prog supports amd64 and arm64" ;;
  esac
}

changes=0
# change <what> <command...>: runs a change, or with --dry-run prints it; either way it counts.
change() {
  local what="$1"
  shift
  changes=$((changes + 1))
  if [ -n "$dry_run" ]; then
    printf 'would: %s\n' "$what"
    return 0
  fi
  printf '+ %s\n' "$what"
  "$@"
}
note() { printf '%s\n' "$1"; }
# summary: how many changes the run made or would make.
summary() {
  echo
  if [ "$changes" -eq 0 ]; then
    echo "Nothing to change: the machine is as asked."
  elif [ -n "$dry_run" ]; then
    echo "$changes change(s) to make; nothing was changed."
  else
    echo "$changes change(s) made."
  fi
}

user_exists() { getent passwd "$user" >/dev/null 2>&1; }
# as_user <command...>: runs a command as the service user, from /, with only its own environment. Before the user
# exists (with --dry-run) it fails, as every check that needs the user then does.
as_user() {
  user_exists || return 1
  (cd / && runuser -u "$user" -- env -i HOME="$home" USER="$user" LOGNAME="$user" SHELL=/bin/bash LANG=C.UTF-8 \
    PATH="$home/.local/bin:$home/.dotnet:$home/.dotnet/tools${root:+:$root/usr/local/bin}:/usr/local/bin:/usr/bin:/bin" \
    DOTNET_ROOT="$home/.dotnet" DOTNET_CLI_TELEMETRY_OPTOUT=1 "$@")
}
# as_user_claude <args...>: runs the user's claude in a session of its own, with nothing on stdin. Run from a terminal,
# claude can touch the terminal after its work is done, and a process outside the terminal's foreground group that
# does is stopped, so the step would never return.
as_user_claude() { as_user setsid -w claude "$@" < /dev/null; }

# A checkout is absent, an empty directory, or already a clone of its repository; anything else is the owner's to sort
# out, so it stops there before anything changes.
same_remote() {
  local url="${1%/}" want="${2,,}"
  url="${url%.git}" url="${url,,}"
  local base="${git_base,,}"
  [ "$url" = "$base$want" ] || [ "$url" = "https://github.com/$want" ] || [ "$url" = "git@github.com:$want" ] \
    || [ "$url" = "ssh://git@github.com/$want" ]
}
# checkout_state <repo> <path>: prints absent, empty or cloned, or fails naming what is wrong.
checkout_state() {
  if [ ! -e "$2" ] && [ ! -L "$2" ]; then
    echo absent
  elif [ -d "$2" ] && [ ! -L "$2" ] && [ -z "$(ls -A -- "$2")" ]; then
    echo empty
  elif user_exists && [ "$(as_user git -C "$2" rev-parse --show-toplevel 2>/dev/null)" = "$(readlink -f -- "$2")" ] \
      && same_remote "$(as_user git -C "$2" remote get-url origin 2>/dev/null)" "$1"; then
    echo cloned
  else
    fail "$2 exists and is not $user's clone of $1; move it away, or give another checkout"
  fi
}

# Packages from Ubuntu's archive (or a vendor's repository once it is added).
apt_fresh=""
installed() {
  [ "$(dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null)" = installed ]
}
apt_update() {
  [ -n "$apt_fresh" ] || { apt-get update -q && apt_fresh=1; }
}
apt_run() {
  apt_update && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "$@"
}
# apt_install <package...>: installs the packages that are not installed yet.
apt_install() {
  local missing=() package
  for package; do installed "$package" || missing+=("$package"); done
  [ ${#missing[@]} -eq 0 ] || change "install ${missing[*]}" apt_run "${missing[@]}" \
    || fail "apt-get could not install ${missing[*]}"
}
# root_file <path> <mode> <content>: writes a file root owns, unless it holds exactly <content> with <mode> already.
write_root_file() {
  install -d -m 755 -- "$(dirname "$1")" && printf '%s' "$3" > "$1.provision" && chmod "$2" "$1.provision" \
    && mv -f -- "$1.provision" "$1"
}
same_root_file() {
  [ -f "$1" ] && [ ! -L "$1" ] && cmp -s -- "$1" <(printf '%s' "$3") && [ "$(stat -c %a -- "$1")" = "$2" ]
}
root_file() {
  same_root_file "$@" || change "write $1" write_root_file "$@" || fail "could not write $1"
}

# bootstrap_helper: a copy of the github-app-token beside this script, in a directory root owns that the user may read
# and run, removed when the script ends; $bootstrap names the directory. Clones use it until Triphammer's checkout puts
# github-app-token on the user's PATH, and provision-project asks it for the App's slug.
bootstrap=""
bootstrap_helper() {
  [ -z "$bootstrap" ] || return 0
  bootstrap="$(mktemp -d "$root/tmp/github-app-token.XXXXXX")" || return 1
  trap 'rm -rf -- "$bootstrap"' EXIT
  [[ "$bootstrap" =~ ^[A-Za-z0-9/._-]+$ ]] || { echo "$prog: the temporary directory $bootstrap needs quoting" >&2; return 1; }
  chmod 755 -- "$bootstrap" && install -m 755 -- "$here/github-app-token" "$bootstrap/github-app-token"
}
# clone <repo> <path>: clones the repository as the user unless it is cloned there already.
clone_into() {
  if [ ! -e "$2" ]; then mkdir -p -- "$2" || return 1; fi
  chown -- "$user:" "$2" || return 1
  if as_user test -x "$home/.local/bin/github-app-token"; then
    as_user git clone -q -- "$git_base$1.git" "$2"
  else
    bootstrap_helper || return 1
    as_user git -c credential.https://github.com.helper= \
      -c "credential.https://github.com.helper=!$bootstrap/github-app-token git-credential" \
      clone -q -- "$git_base$1.git" "$2"
  fi
}
clone() {
  local state
  state="$(checkout_state "$1" "$2")"
  [ "$state" != cloned ] || return 0
  change "clone $1 into $2 as $user" clone_into "$1" "$2" \
    || fail "could not clone $1 into $2; a private repository needs the App's files in $home/.config/github-app first (bin/README.md, On a machine of its own), then run $prog again"
}
# cloned <repo> <path>: succeeds when the checkout is there: always, but with --dry-run, where a clone may only be
# planned.
cloned() { [ -z "$dry_run" ] || [ "$(checkout_state "$1" "$2" 2>/dev/null)" = cloned ]; }
# user_link <link> <target>: a symlink the user owns, unless it points there already.
user_link() {
  [ "$(readlink -- "$1" 2>/dev/null)" = "$2" ] && return 0
  change "link $1 to $2" as_user sh -c 'mkdir -p "$(dirname "$1")" && ln -sfn "$2" "$1"' sh "$1" "$2" \
    || fail "could not link $1"
}
# user_file <path> <mode> <content>: a file the user owns, unless it holds exactly <content> with <mode> already. A
# file with other content is kept beside it as <path>.old.
write_user_file() {
  printf '%s' "$3" | as_user sh -c 'umask 077 && mkdir -p "$(dirname "$1")" && { [ ! -e "$1" ] || cp -p "$1" "$1.old"; } \
    && cat > "$1.provision" && chmod "$2" "$1.provision" && mv -f "$1.provision" "$1"' sh "$1" "$2"
}
user_file() {
  if printf '%s' "$3" | as_user cmp -s -- "$1" - 2>/dev/null && [ "$(stat -c %a -- "$1")" = "$2" ]; then return 0; fi
  local what="write $1"
  [ ! -e "$1" ] || what="rewrite $1 (the file it replaces is kept as $1.old)"
  change "$what" write_user_file "$@" || fail "could not write $1"
}
# reload_units: reloads the user's systemd units.
reload_units() {
  change "reload $user's systemd units" systemctl --machine="$user@" --user daemon-reload \
    || fail "systemctl could not reload $user's units"
}
# user_enabled <unit>: succeeds when the user's unit is enabled.
user_enabled() {
  user_exists && systemctl --machine="$user@" --user is-enabled --quiet -- "$1" >/dev/null 2>&1
}

# in_group <user> <group>: succeeds when the user is a member of the group.
in_group() { id -nG "$1" 2>/dev/null | tr ' ' '\n' | grep -qxF -- "$2"; }
# linger <user>: lingering on for the user, so its user units run without a login.
linger() {
  if [ "$(loginctl show-user "$1" --property=Linger --value 2>/dev/null)" != yes ]; then
    change "turn lingering on for $1, so its user units run without a login" loginctl enable-linger "$1" \
      || fail "loginctl enable-linger failed"
  fi
}
# leave_group <user> <group>: takes the user out of the group when it is in it.
leave_group() {
  in_group "$1" "$2" || return 0
  change "remove $1 from the $2 group" gpasswd -d "$1" "$2" || fail "gpasswd could not remove $1 from $2"
}

# as_docker <command...>: runs one of the functions above (as_user, user_file, reload_units, ...) for a rootless
# Docker daemon's user, docker_user with its home docker_home, in place of the service user.
as_docker() {
  local user="$docker_user" home="$docker_home"
  "$@"
}
# acl <path> <entry...>: adds each ACL entry (in getfacl's form, such as user:<name>:r-x) that <path> lacks or whose
# rights the mask cuts (a chmod sets the mask), which getfacl marks with #effective after the entry; setfacl -m
# recalculates the mask.
acl() {
  local path="$1" entry missing=()
  shift
  for entry; do
    getfacl -cp -- "$path" 2>/dev/null | grep -qxF -- "$entry" || missing+=("$entry")
  done
  [ ${#missing[@]} -eq 0 ] && return 0
  local IFS=,
  change "grant ${missing[*]} on $path" setfacl -m "${missing[*]}" -- "$path" || fail "setfacl could not change $path"
}
# docker_reads <checkout>: lets a project's rootless Docker daemon's user read the run clones in <checkout>/.worktrees, which
# a project's Compose files bind-mount, and nothing else of the service user's: read and search on .worktrees, with a
# default entry so each clone a run makes there inherits both, and search alone (--x, which lists nothing) on the
# checkout and each directory above it that the service user owns. It creates .worktrees as the user when it is
# missing.
docker_reads() {
  local worktrees="$1/.worktrees" dir="$1" uid
  if ! as_user test -d "$worktrees"; then
    change "create $worktrees as $user" as_user mkdir -p -- "$worktrees" || fail "could not create $worktrees"
  fi
  acl "$worktrees" "user:$docker_user:r-x" "default:user:$docker_user:r-x"
  uid="$(id -u "$user")"
  while [ -n "$dir" ]; do
    [ "$(stat -c %u -- "$dir" 2>/dev/null)" != "$uid" ] || acl "$dir" "user:$docker_user:--x"
    dir="${dir%/*}"
  done
}

# docker_home: makes each directory docker_home_shape (config.sh) names root's, mode 755, from the home down, creating the missing
# ones, so the daemon's user, and a container on its daemon, can write none of what its user manager, its user bus or
# dockerd read as code or config there. A home the user owns is taken over the same way. A symlink
# or other file where a directory belongs stops the run without being followed, as does any entry of those directories
# other than the shape's, once all of them are root's: the user may have planted it, so the owner looks at it and
# removes it, as nothing here deletes it. Last, the daemon's data-root, ~/.local/share/docker, is the user's, mode 700
# when made here, the one place in the home dockerd writes.
docker_home() {
  local line dir path name want entries strays=() data="$docker_home/.local/share/docker"
  for line in "${docker_home_shape[@]}"; do
    read -ra entries <<< "$line"
    dir="${entries[0]}" path="$docker_home"
    [ "$dir" = . ] || path="$docker_home/$dir"
    if [ -L "$path" ] || { [ -e "$path" ] && [ ! -d "$path" ]; }; then
      fail "$path is a symlink or not a directory, where $docker_user's home needs a directory root owns, and $docker_user may have planted it: look at it, remove it, then run $prog again"
    fi
    [ "$(stat -c '%u %a' -- "$path" 2>/dev/null)" = "0 755" ] \
      || change "make $path root's, mode 755, so $docker_user cannot change what it holds" \
        sh -c 'mkdir -p -- "$1" && chown -- root:root "$1" && chmod 755 -- "$1"' sh "$path" \
      || fail "could not make $path root's"
    while IFS= read -r name; do
      for want in "${entries[@]:1}"; do [ "$name" != "$want" ] || continue 2; done
      strays+=("$path/$name")
    done < <(find "$path" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | LC_ALL=C sort)
  done
  [ ${#strays[@]} -eq 0 ] \
    || fail "$docker_user's home holds ${strays[*]}, which $prog did not write and $docker_user may have planted to run code as itself: look at each, remove it, then run $prog again"
  if [ -L "$data" ] || { [ -e "$data" ] && [ ! -d "$data" ]; }; then
    fail "$data is a symlink or not a directory, where the daemon's data-root belongs, and $docker_user may have planted it: look at it, remove it, then run $prog again"
  fi
  if ! [ -d "$data" ] || [ "$(stat -c %u -- "$data")" != "$(id -u "$docker_user" 2>/dev/null)" ]; then
    change "make $data, mode 700, $docker_user's, for its daemon's images, containers and volumes" \
      sh -c 'mkdir -p -- "$1" && chmod 700 -- "$1" && chown -- "$2:" "$1"' sh "$data" "$docker_user" \
      || fail "could not make $data"
  fi
}
# write_docker_unit <path> <content>: writes the daemon's unit as root_file does, and makes it root's.
write_docker_unit() { write_root_file "$1" 644 "$2" && chown -- root:root "$1"; }

# docker_daemon <project> <checkout>: the rootless Docker daemon of one project that declares "docker": true, which its
# sessions alone reach, so no other project's session reaches its containers, images, volumes, networks or build
# cache; that is no security boundary, as projects on one machine are not kept apart (bin/README.md, Several projects). It runs as a
# user of its own, <user>-docker-<project>, in a user namespace on that user's subordinate ids, so
# a container that mounts / or runs privileged acts as that user on the machine, and that user may read only the
# project's run clones (docker_reads). It is in neither the service user's group nor the docker group. Its home, beside
# the service user's, is root's but for the daemon's data-root, ~/.local/share/docker, which holds the images,
# containers and volumes (docker_home): root writes the daemon's user unit and links it into default.target.wants, as
# systemctl enable would, so in the home a container on the daemon writes only that data-root; beyond it, it writes the
# user's runtime directory /run/user/<uid> and the socket's directory, as bin/README.md's Not covered says. A project
# whose name has no docker_key (config.sh), or whose user's name would be longer than the 32 characters useradd takes,
# stops the run: a shortened name could be another project's.
#
# The socket: dockerd, started with --host, makes it at /var/lib/<daemon user>/docker.sock, in a directory of its own
# that the daemon's user owns with mode 700, outside /run, which RootlessKit replaces in the daemon's mount namespace
# with a copy. The directory's ACL lets the service user search it (--x) and nothing more, and the unit's
# ExecStartPost gives the service user rw- on the socket once the daemon is ready, whatever mode and group dockerd gave
# it; connecting to a socket takes write on it and search on its directory. No other user but root can reach it, and
# the write limit hides it from every other project's session (bin/session-sandbox). Last, the machine file names the
# user and the socket under the project's keys.
docker_daemon() {
  local project="$1" key script kind start rewritten=""
  key="$(docker_key "$project")" \
    || fail "the project $project declares \"docker\": true, and its name cannot name a rootless Docker daemon: rename the project to lower-case letters, digits and dashes, starting with a letter or a digit"
  docker_user="$user-docker-$project"
  [[ "$docker_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] \
    || fail "the rootless Docker daemon of $project would run as $docker_user, ${#docker_user} characters, and a user name has at most 32; give the project a shorter name"
  if installed docker-ce-rootless-extras; then script=/usr/bin/dockerd-rootless.sh
  elif installed docker.io && installed rootlesskit; then script=/usr/share/docker.io/contrib/dockerd-rootless.sh
  else fail "the rootless Docker daemon's packages are missing; run triphammer update (or bin/provision) first"
  fi
  local docker_dir="$root/var/lib/$docker_user"
  local docker_socket="$docker_dir/docker.sock"
  docker_home="$(dirname "$home")/$docker_user"
  if getent passwd "$docker_user" >/dev/null 2>&1; then
    docker_home="$(getent passwd "$docker_user" | cut -d: -f6)"
  else
    change "create the user $docker_user with the home $docker_home, for the rootless Docker daemon of $project" \
      useradd --no-create-home --home-dir "$docker_home" --shell /usr/sbin/nologin --user-group "$docker_user" \
      || fail "useradd failed"
  fi
  docker_home
  leave_group "$docker_user" "$user"
  leave_group "$docker_user" docker
  linger "$docker_user"

  # Its subordinate uids and gids, 65536 of each, from the first id (at least 100000) past every range /etc/subuid, or
  # /etc/subgid, holds; Ubuntu's useradd gives a new user them itself, which leaves nothing to do here.
  for kind in uid gid; do
    grep -q "^$docker_user:" "$root/etc/sub$kind" 2>/dev/null && continue
    start="$({ cat -- "$root/etc/sub$kind" 2>/dev/null || true; } \
      | awk -F: 'BEGIN { end = 100000 } NF >= 3 && $2 + $3 > end { end = $2 + $3 } END { print end }')"
    change "give $docker_user the subordinate ${kind}s $start-$((start + 65535))" \
      usermod "--add-sub${kind}s" "$start-$((start + 65535))" "$docker_user" || fail "usermod could not add $docker_user's sub${kind}s"
  done

  # Its group bits are the ACL's mask, --x once the grant below is in, so a mode of 700 or 710 is as asked.
  if [ ! -d "$docker_dir" ] || [ -L "$docker_dir" ] \
    || [[ "$(stat -c '%u %a' -- "$docker_dir")" != "$(id -u "$docker_user" 2>/dev/null) 7"[01]0 ]]; then
    change "create $docker_dir, mode 700, for $docker_user's socket" \
      sh -c 'mkdir -p -- "$1" && chmod 700 -- "$1" && chown -- "$2:" "$1"' sh "$docker_dir" "$docker_user" \
      || fail "could not create $docker_dir"
  fi
  acl "$docker_dir" "user:$user:--x"

  # The daemon's user unit, as dockerd-rootless-setuptool.sh install writes it, with the socket's path and its grant,
  # root's, and its link in default.target.wants, as systemctl --user enable makes it. A unit of other content is
  # rewritten and the running daemon restarted; one of the same content the user owns only becomes root's.
  local units="$docker_home/.config/systemd/user" content
  local unit="$units/docker.service" link="$units/default.target.wants/docker.service"
  { [ ! -e "$unit" ] || [ -f "$unit" ]; } && [ ! -L "$unit" ] \
    || fail "$unit is a symlink or not a regular file, where root writes the daemon's unit, and $docker_user may have planted it: look at it, remove it, then run $prog again"
  [ ! -e "$link" ] || [ -L "$link" ] \
    || fail "$link is not a symlink, where the daemon's unit is linked, and $docker_user may have planted it: look at it, remove it, then run $prog again"
  content="# Written by Triphammer's bin/provision-project: the rootless Docker daemon of the project $project, whose socket $user reaches (bin/README.md).
[Unit]
Description=Docker Application Container Engine (Rootless), for $user's project $project
Documentation=https://docs.docker.com/go/rootless/
Requires=dbus.socket

[Service]
Environment=PATH=/usr/bin:/sbin:/usr/sbin:/bin
ExecStart=$script --host=unix://$docker_socket
ExecStartPost=/usr/bin/setfacl -m user:$user:rw- $docker_socket
ExecReload=/bin/kill -s HUP \$MAINPID
TimeoutSec=0
RestartSec=2
Restart=always
StartLimitBurst=3
StartLimitInterval=60s
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
TasksMax=infinity
Delegate=yes
Type=notify
NotifyAccess=all
KillMode=mixed

[Install]
WantedBy=default.target
"
  if ! same_root_file "$unit" 644 "$content"; then
    change "write $unit, root's" write_docker_unit "$unit" "$content" || fail "could not write $unit"
    rewritten=1
  elif [ "$(stat -c %u -- "$unit")" != 0 ]; then
    change "make $unit root's" chown -- root:root "$unit" || fail "could not make $unit root's"
  fi
  if [ "$(readlink -- "$link")" != "$unit" ]; then
    change "enable $docker_user's docker.service, the rootless Docker daemon of $project: link $link to it" \
      ln -sfn -- "$unit" "$link" || fail "could not link $link"
    as_docker reload_units
    change "start $docker_user's docker.service" systemctl --machine="$docker_user@" --user start docker.service \
      || fail "systemctl could not start $docker_user's docker.service; journalctl --machine=$docker_user@ --user -u docker.service says why"
  elif [ -n "$rewritten" ]; then
    as_docker reload_units
    change "restart $docker_user's docker.service, whose unit changed" systemctl --machine="$docker_user@" --user restart docker.service \
      || fail "systemctl could not restart $docker_user's docker.service"
  fi

  docker_reads "$2"
  root_file "$machine_file" 644 \
    "$(machine_with "TRIPHAMMER_DOCKER_USER_$key=$docker_user" "TRIPHAMMER_DOCKER_SOCKET_$key=$docker_socket")"$'\n'
}

# owner_steps: what is left for the owner, numbered, each with its fix, or one line saying the machine is ready. It
# reads only what the machine can tell without a credential's value and prints no file's content and no command's
# output: the App's files by owner and mode alone (stat, as the doctor checks) and, when all three pass, whether GitHub
# accepts the App's key (github-app-token app-slug as the user, from the copy beside this script); Claude Code's login
# by the exit status of claude auth status, as the user in a session of its own (its output can name the account); the
# projects' configs in ~/.config/triphammer and whether their timers are enabled; and whether the status page is.
owner_steps() {
  local app_dir="$home/.config/github-app" uid name path what owner mode step=0 app=() projects=() off="" lines=()
  uid="$(id -u "$user" 2>/dev/null || true)"
  for name in app-id owner agents.pem; do
    path="$app_dir/$name"
    case "$name" in
      app-id) what="the App's numeric id" ;;
      owner) what="the login of the account the App is installed on" ;;
      agents.pem) what="the App's private key" ;;
    esac
    if [ ! -e "$path" ]; then
      app+=("$name is missing: put $what in $path, owned by $user, mode 600")
    elif [ ! -f "$path" ]; then
      app+=("$name is not a regular file: replace $path with $what, owned by $user, mode 600")
    else
      read -r owner mode < <(stat -L -c '%u %a' -- "$path")
      { [ -n "$uid" ] && [ "$owner" = "$uid" ]; } || app+=("$name is not owned by $user: chown $user $path")
      [ "$mode" = 600 ] || app+=("$name has mode $mode, not 600: chmod 600 $path")
    fi
  done
  if [ ${#app[@]} -eq 0 ] && ! { bootstrap_helper && as_user "$bootstrap/github-app-token" app-slug >/dev/null 2>&1; }; then
    app+=("GitHub did not accept the App's key, or could not be reached: app-id or agents.pem is not the App's; replace them with the App's, owned by $user, mode 600")
  fi
  if [ ${#app[@]} -gt 0 ]; then
    lines+=("  $((step += 1)). The App's files in $app_dir:")
    for what in "${app[@]}"; do lines+=("     - $what"); done
  fi

  if ! as_user_claude auth status >/dev/null 2>&1; then
    lines+=("  $((step += 1)). Log Claude Code in: sudo -iu $user claude auth login (or claude setup-token; bin/README.md).")
  fi

  for path in "$home/.config/triphammer"/*.conf; do
    name="${path##*/}" name="${name%.conf}"
    { [ -f "$path" ] && [[ "$name" =~ ^[A-Za-z0-9_-][A-Za-z0-9._-]*$ ]]; } || continue
    if user_enabled "ticket-runner@$name.timer" && user_enabled "merge-when-ready@$name.timer"; then
      projects+=("     - $name: its timers are on")
    else
      projects+=("     - $name: triphammer start $name")
      off=1
    fi
  done
  if [ ${#projects[@]} -eq 0 ]; then
    lines+=("  $((step += 1)). Add a project: triphammer add <owner>/<repo>")
  elif [ -n "$off" ]; then
    lines+=("  $((step += 1)). Start the projects whose timers are off (triphammer add <owner>/<repo> adds another):" "${projects[@]}")
  fi

  if ! user_enabled triphammer-status.service; then
    lines+=("  $((step += 1)). Optionally the status page: sudo systemctl --machine=$user@ --user enable --now triphammer-status.service")
  fi

  echo
  if [ "$step" -eq 0 ]; then
    echo "Nothing left for the owner: the machine is ready."
  else
    echo "Next, as the owner (provision never reads or writes a credential):"
    printf '%s\n' "${lines[@]}"
  fi
}
