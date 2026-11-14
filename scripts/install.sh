#!/bin/sh
# Open Agent API installer for Linux (x64 and arm64).
#
#   curl -fsSL https://github.com/jiangxingfan1-coder/Open-Agent-API/releases/latest/download/install.sh | sh
#   sh install.sh [--version X.Y.Z] [--prefix DIR] [--uninstall] [--help]
#
# Downloads the .tar.gz for this CPU from the GitHub release, checks it against the release's
# SHA256SUMS, unpacks it to PREFIX/share/open-agent-api and links PREFIX/bin/oaa to the launcher
# (PREFIX defaults to ~/.local). No root, nothing outside those two places is touched, no shell
# profile is edited. Your data directories (.oaa) are never removed.
#
# Everything is inside functions and the last line calls main inside a brace group: a download cut
# short by a dropped connection leaves an incomplete function or an incomplete group, which the shell
# refuses to run (a bare `main` prefix of the call would run with the wrong arguments).
#
# Environment (mostly for testing): OAA_VERSION (same as --version), OAA_DOWNLOAD_BASE (a URL or
# file:// directory holding the .tar.gz and SHA256SUMS instead of the GitHub release).

OAA_REPO="jiangxingfan1-coder/Open-Agent-API"
OAA_STAMPED_VERSION="@OAA_VERSION@"

oaa_say() { printf '%s\n' "$*"; }
oaa_err() { printf 'install.sh: %s\n' "$*" >&2; }
oaa_die() {
  oaa_err "$*"
  exit 1
}

oaa_usage() {
  cat <<'USAGE'
Usage: sh install.sh [options]
  --version X.Y.Z   install this version (default: the version this script belongs to, else the latest release)
  --prefix DIR      install under DIR/share/open-agent-api and link DIR/bin/oaa (default: ~/.local)
  --uninstall       remove the installation and the DIR/bin/oaa link (data directories are kept)
  --help            show this text
用法：sh install.sh [--version 版本] [--prefix 目录] [--uninstall] [--help]
默认装到 ~/.local/share/open-agent-api 并把 ~/.local/bin/oaa 链接过去；不需要 root，不改系统配置；
--uninstall 卸载安装目录与链接（不删除 .oaa 数据目录）。
USAGE
}

# oaa_fetch URL OUT: download with curl, or wget when there is no curl (file:// needs curl).
oaa_fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1" || oaa_die "download failed: $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1" || oaa_die "download failed: $1"
  else
    oaa_die "need curl or wget to download. / 需要 curl 或 wget 才能下载。"
  fi
}

oaa_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    oaa_die "need sha256sum or shasum to verify the download. / 需要 sha256sum 或 shasum 校验下载。"
  fi
}

oaa_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x64' ;;
    aarch64 | arm64) printf 'arm64' ;;
    *) oaa_die "unsupported CPU $(uname -m): packages exist for x86_64 and aarch64. / 不支持的 CPU。" ;;
  esac
}

oaa_latest_version() {
  command -v curl >/dev/null 2>&1 || oaa_die "need curl to look up the latest version; or pass --version X.Y.Z. / 查最新版需要 curl，或用 --version 指定版本。"
  url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$OAA_REPO/releases/latest")" ||
    oaa_die "could not look up the latest release; pass --version X.Y.Z. / 查不到最新版本，请用 --version 指定。"
  printf '%s' "${url##*/}" | sed 's/^v//'
}

# oaa_remove_link LINK TARGET: remove LINK only when it is a symlink to TARGET (ours).
oaa_remove_link() {
  if [ -L "$1" ] && [ "$(readlink "$1")" = "$2" ]; then
    rm -f "$1"
    oaa_say "Removed link $1"
  fi
}

oaa_uninstall() {
  dest="$1/share/open-agent-api"
  oaa_remove_link "$1/bin/oaa" "$dest/oaa"
  if [ -e "$dest" ]; then
    rm -rf "$dest"
    oaa_say "Removed $dest"
  else
    oaa_say "Nothing to remove at $dest"
  fi
  oaa_say "Your data directories (.oaa) were not touched. If a gateway is still running, stop it with: oaa stop"
}

oaa_install() {
  prefix="$1"
  version="$2"
  [ "$(uname -s)" = "Linux" ] || oaa_die "this installer is for Linux; macOS and Windows have their own packages. / 本脚本只用于 Linux。"
  if ldd --version 2>&1 | grep -qi musl; then
    oaa_die "this system uses musl libc (for example Alpine); the package needs glibc 2.28 or newer. Use the Docker image instead. / 本系统是 musl（如 Alpine），请改用 Docker 镜像。"
  fi
  arch="$(oaa_arch)"
  name="Open-Agent-API-$version-linux-$arch"
  base="${OAA_DOWNLOAD_BASE:-https://github.com/$OAA_REPO/releases/download/v$version}"
  dest="$prefix/share/open-agent-api"
  link="$prefix/bin/oaa"

  if [ -e "$link" ] || [ -L "$link" ]; then
    if [ ! -L "$link" ] || { [ "$(readlink "$link")" != "$dest/oaa" ] && [ -e "$link" ]; }; then
      oaa_die "$link already exists and is not a link to this installation; remove it or choose another --prefix. / $link 已存在且不是本安装的链接，请先移走它或换 --prefix。"
    fi
  fi

  mkdir -p "$prefix/share" "$prefix/bin" || oaa_die "cannot create directories under $prefix"
  work="$(mktemp -d "$prefix/share/.open-agent-api-install.XXXXXX")" || oaa_die "cannot create a temporary directory under $prefix/share"
  trap 'rm -rf "$work"' EXIT
  trap 'exit 1' INT TERM HUP

  oaa_say "Downloading $name.tar.gz (v$version)"
  oaa_fetch "$base/$name.tar.gz" "$work/$name.tar.gz"
  oaa_fetch "$base/SHA256SUMS" "$work/SHA256SUMS"
  expected="$(awk -v f="$name.tar.gz" '$2 == f || $2 == "*" f { print $1; exit }' "$work/SHA256SUMS")"
  [ -n "$expected" ] || oaa_die "SHA256SUMS has no entry for $name.tar.gz"
  actual="$(oaa_sha256 "$work/$name.tar.gz")"
  [ "$expected" = "$actual" ] || oaa_die "SHA-256 mismatch for $name.tar.gz (expected $expected, got $actual); the download was not installed. / SHA-256 不符，未安装。"
  oaa_say "SHA-256 verified"

  mkdir "$work/unpacked"
  tar -xzf "$work/$name.tar.gz" -C "$work/unpacked" || oaa_die "could not unpack the archive"
  top="$work/unpacked/Open-Agent-API-linux-$arch"
  [ -x "$top/oaa" ] && [ -x "$top/runtime/bin/node" ] || oaa_die "the archive does not look like an Open Agent API package"

  if [ -e "$dest" ]; then
    mv "$dest" "$work/previous" || oaa_die "could not move the previous installation aside"
  fi
  if ! mv "$top" "$dest"; then
    [ -e "$work/previous" ] && mv "$work/previous" "$dest"
    oaa_die "could not move the new installation into place"
  fi
  ln -sfn "$dest/oaa" "$link" || oaa_die "could not create the link $link"

  if ! "$link" --help >/dev/null 2>&1; then
    oaa_err "installed to $dest, but oaa did not start; this system may not meet the package's glibc 2.28 requirement. / 已安装但 oaa 无法启动，可能不满足 glibc 2.28。"
    exit 1
  fi
  oaa_say "Installed Open Agent API $version to $dest"
  oaa_say "Command: $link"
  case ":$PATH:" in
    *":$prefix/bin:"*) ;;
    *) oaa_say "Add it to your PATH (put this line in your shell profile): export PATH=\"$prefix/bin:\$PATH\"" ;;
  esac
  oaa_say "Next: oaa quickstart    (stop with: oaa stop; uninstall with: sh install.sh --uninstall)"
}

main() {
  set -eu
  version_arg="${OAA_VERSION:-}"
  prefix=""
  uninstall=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --version)
        [ $# -ge 2 ] || oaa_die "--version needs a value"
        version_arg="$2"
        shift 2
        ;;
      --prefix)
        [ $# -ge 2 ] || oaa_die "--prefix needs a value"
        prefix="$2"
        shift 2
        ;;
      --uninstall)
        uninstall=1
        shift
        ;;
      -h | --help)
        oaa_usage
        return 0
        ;;
      *) oaa_die "unknown option: $1 (see --help)" ;;
    esac
  done
  if [ -z "$prefix" ]; then
    [ -n "${HOME:-}" ] || oaa_die "HOME is not set; pass --prefix DIR"
    prefix="$HOME/.local"
  fi
  case "$prefix" in /*) ;; *) prefix="$PWD/$prefix" ;; esac
  prefix="${prefix%/}"
  if [ "$uninstall" = 1 ]; then
    oaa_uninstall "$prefix"
    return 0
  fi
  version="$version_arg"
  if [ -z "$version" ]; then
    case "$OAA_STAMPED_VERSION" in
      @*) version="$(oaa_latest_version)" ;;
      *) version="$OAA_STAMPED_VERSION" ;;
    esac
  fi
  case "$version" in
    "" | *[!0-9A-Za-z.+-]*) oaa_die "invalid version: $version" ;;
  esac
  oaa_install "$prefix" "$version"
}

{ main "$@"; }
