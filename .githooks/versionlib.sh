#!/bin/sh
VERSION_FILE=VERSION
IDENT_RE='^v[0-9]+\.[0-9]\.[0-9]{1,2}[+-][0-9]{6}[1-9a-z]$'

die() { echo "alfazen-versioning: $*" >&2; exit 1; }
utc_yymmdd() { TZ=UTC LC_ALL=C date -u +%y%m%d; }

read_version() {
  [ -f "$VERSION_FILE" ] || die "root $VERSION_FILE file is missing"
  id=$(tr -d '\r\n\t ' < "$VERSION_FILE")
  [ -n "$id" ] || die "$VERSION_FILE is empty"
  printf '%s\n' "$id"
}

validate_identifier() {
  id=$1
  printf '%s' "$id" | grep -Eq "$IDENT_RE" || die "malformed identifier '$id' in $VERSION_FILE"
  case $id in *+*) build=${id#*+} ;; *-*) build=${id#*-} ;; esac
  bdate=${build%?}
  printf '%s\n' "$bdate" | awk '
    {
      year = 2000 + substr($0, 1, 2)
      month = substr($0, 3, 2) + 0
      day = substr($0, 5, 2) + 0
      leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
      days = (month == 2 ? 28 + leap : (month == 4 || month == 6 || month == 9 || month == 11 ? 30 : 31))
      if (month < 1 || month > 12 || day < 1 || day > days) exit 1
    }
  ' || die "invalid BUILD date in '$id'"
  today=$(utc_yymmdd)
  [ "$bdate" -le "$today" ] || die "future-dated BUILD in '$id'"
}

# Only feat commits move the patch digit. Every other commit keeps the same
# semver and advances the build counter, so the identifier still changes.
detect_bump_type() {
  msg=$1
  case "$msg" in
    *BREAKING\ CHANGE*|*!:\ *) echo "major_requires_approval" ;;
    feat:*|feat\(*\):*)        echo "patch" ;;
    *)                         echo "build" ;;
  esac
}

bump_semver() {
  ver=$1; bump=$2
  raw=${ver#v}
  m=$(echo "$raw" | cut -d. -f1)
  n=$(echo "$raw" | cut -d. -f2)
  p=$(echo "$raw" | cut -d. -f3)

  case "$bump" in
    major)
      [ "${ALFAZEN_MAJOR_APPROVED:-0}" = "1" ] || die "Major version bump (m) requires explicit user approval. Set ALFAZEN_MAJOR_APPROVED=1 to proceed."
      echo "v$((m + 1)).0.0"
      ;;
    major_requires_approval)
      die "Major version bump (m) detected. Major version increments require explicit user approval. Set ALFAZEN_MAJOR_APPROVED=1 to proceed, or stage as minor/patch."
      ;;
    minor)
      if [ "$n" -eq 9 ]; then echo "v$((m + 1)).0.0"
      else echo "v${m}.$((n + 1)).0"; fi
      ;;
    patch)
      if [ "$p" -ge 99 ]; then
        die "patch digit is capped at 99; a minor bump requires explicit approval"
      fi
      echo "v${m}.${n}.$((p + 1))"
      ;;
    *)     echo "v${m}.${n}.${p}" ;;
  esac
}

next_identifier() {
  old=$1; today=$2; bump=${3:-build}
  case $old in *+*) ver=${old%+*}; build=${old#*+} ;; *-*) ver=${old%-*}; build=${old#*-} ;; esac
  bdate=${build%?}
  bctr=${build#??????}

  # Apply semantic bump if requested
  ver=$(bump_semver "$ver" "$bump")

  if [ "$bdate" != "$today" ]; then
    nctr=1
  else
    case $bctr in
      [1-8]) nctr=$((bctr + 1)) ;;
      9)     nctr=a ;;
      [a-y]) nctr=$(printf '%s' "$bctr" | tr 'a-y' 'b-z') ;;
      z)     die "daily counter exhausted for $today" ;;
      *)     die "invalid counter '$bctr'" ;;
    esac
  fi
  printf '%s+%s%s\n' "$ver" "$today" "$nctr"
}

# Replace the first "<key>": "..." value in a JSON file without needing GNU sed.
set_json_version() {
  file=$1; version=$2
  [ -f "$file" ] || return 0
  tmp=$(mktemp) || die "could not create a temp file for $file"
  awk -v v="$version" '
    !done && /"version"[[:space:]]*:/ {
      sub(/"version"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"version\": \"" v "\"")
      done = 1
    }
    { print }
  ' "$file" > "$tmp" && mv -f -- "$tmp" "$file" || die "could not update $file"
  git add -- "$file"
}

# Replace the first "version = "..." line, which is the [package] version.
set_toml_version() {
  file=$1; version=$2
  [ -f "$file" ] || return 0
  tmp=$(mktemp) || die "could not create a temp file for $file"
  awk -v v="$version" '
    !done && /^version[[:space:]]*=/ { sub(/"[^"]*"/, "\"" v "\""); done = 1 }
    { print }
  ' "$file" > "$tmp" && mv -f -- "$tmp" "$file" || die "could not update $file"
  git add -- "$file"
}

# Replace the version of this crate's own entry in Cargo.lock.
set_lock_version() {
  file=$1; version=$2; crate=$3
  [ -f "$file" ] || return 0
  tmp=$(mktemp) || die "could not create a temp file for $file"
  awk -v v="$version" -v crate="$crate" '
    $0 == "name = \"" crate "\"" { found = 1; print; next }
    found && /^version[[:space:]]*=/ { sub(/"[^"]*"/, "\"" v "\""); found = 0 }
    { print }
  ' "$file" > "$tmp" && mv -f -- "$tmp" "$file" || die "could not update $file"
  git add -- "$file"
}

# Read the [package] name so Cargo.lock can be updated without hardcoding it.
cargo_package_name() {
  [ -f src-tauri/Cargo.toml ] || return 0
  awk '
    /^\[package\]/ { section = 1; next }
    /^\[/ { section = 0 }
    section && /^name[[:space:]]*=/ {
      line = $0
      sub(/^name[[:space:]]*=[[:space:]]*"/, "", line)
      sub(/".*/, "", line)
      print line
      exit
    }
  ' src-tauri/Cargo.toml
}

# Keep every manifest on the same semver as VERSION, minus the build metadata.
# Manifests are optional so the hook still works in a bare test repository.
sync_manifests() {
  identifier=$1
  semver=${identifier#v}
  semver=${semver%%+*}
  semver=${semver%%-*}
  set_json_version package.json "$semver"
  set_json_version src-tauri/tauri.conf.json "$semver"
  set_toml_version src-tauri/Cargo.toml "$semver"
  crate=$(cargo_package_name)
  [ -n "$crate" ] && set_lock_version src-tauri/Cargo.lock "$semver" "$crate"
  return 0
}
