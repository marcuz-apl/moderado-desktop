#!/bin/sh
VERSION_FILE=VERSION
IDENT_RE='^v[0-9]+\.[0-9]\.[0-9][+-][0-9]{6}[1-9a-z]$'

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

detect_bump_type() {
  msg=$1
  case "$msg" in
    *BREAKING\ CHANGE*|*!:\ *) echo "major_requires_approval" ;;
    feat:*|feat\(*\):*)        echo "patch" ;;
    fix:*|fix\(*\):*|perf:*)   echo "patch" ;;
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
    minor) echo "v${m}.$((n + 1)).0" ;;
    patch)
      if [ "$p" -eq 9 ]; then
        if [ "$n" -eq 9 ]; then echo "v$((m + 1)).0.0"
        else echo "v${m}.$((n + 1)).0"; fi
      else echo "v${m}.${n}.$((p + 1))"; fi
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
