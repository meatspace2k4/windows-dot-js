#!/usr/bin/env bash
#
# Deploy Windows 95 to the Pi as "win95", the process deploy/dustytrails/deploy_to_pi.sh (mobileair) uses for
# dustytrails: a signed build, stamped into the page and into every asset's ?v=, staged locally and rsynced.
#
# Target: the Pi in deploy.config (PI_HOST, PI_USER), or its reproduction on this machine (PI_ROOT)
# Service: win95 (win95_server.py on 127.0.0.1:8770, reached through cloudflared)
#   win95.funstuff.app      ~/win95/site        (production)
#   win95-dev.funstuff.app  ~/win95-dev/site    (dev; the same service, chosen by Host)
#
# Usage:
#   ./deploy.sh --commit <sha> --version <ver>                          # DEV (default): front end only
#   W95_ALLOW_PROD=1 ./deploy.sh --prod --commit <sha> --version <ver>  # production: files + service
#   ./deploy.sh --build-only                                            # stage only, nothing shipped

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────
SERVICE_NAME="win95"
SITE_PORT="8770"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STAGING_DIR="$SCRIPT_DIR/.staging"

# Deploy signature. Every deploy (dev or prod) MUST be invoked with:
#   --commit <short sha>   the commit being shipped; verified against .git/HEAD
#                          by reading the files directly (this script never
#                          runs git: a deploy command must not carry a git call)
#   --version <ver>        <MAJOR>-<M><I>, e.g. 0-01 (= v0.0.1), 1-11 (= v1.1.1)
# The signature is  <version>+<commit>  (e.g. 0-01+e2189dc). It becomes every
# asset's ?v= cache-bust, the service worker's cache name AND the dev title bar
# text "[DEV 0-01+e2189dc]", so what a browser shows is, by construction, the
# commit that was typed and verified for that deploy. Only --build-only may run
# without them; it then stamps ?v= with the clock and ships nothing.
DEPLOY_COMMIT=""
DEPLOY_VERSION=""
DEPLOY_SIG=""

# Generated from the Windows 95 CD and gitignored (tools/build_*.py, extract.py): a checkout has none of them. They
# come from the working tree on the Mac, and from ~/win95-deploy-inputs (copied into the checkout) on the runner.
GENERATED=(system.js savers.js assets.js assets-shell.js cdrom.js floppy.js)
CD_IMAGE="cdrom.iso"

BUILD_ONLY=0
for _arg in "$@"; do
    if [[ "$_arg" == "--build-only" ]]; then
        BUILD_ONLY=1
    fi
done
unset _arg

PI_CONFIG_PLACEHOLDER=0

if [[ -f "$SCRIPT_DIR/deploy.config" ]]; then
    # shellcheck source=deploy.config.example
    source "$SCRIPT_DIR/deploy.config"
elif [[ "$BUILD_ONLY" == "1" ]]; then
    echo -e "\033[1;33m[WARN]\033[0m deploy.config not found — continuing because --build-only was given."
else
    echo -e "\033[0;31m[ERROR]\033[0m deploy.config not found."
    echo -e "        Copy deploy.config.example to deploy.config and fill in your values."
    exit 1
fi

# PI_ROOT: a folder on this machine laid out as the Pi's filesystem (<PI_ROOT>/home/<PI_USER>/win95 ...). With it,
# every step that would ssh or rsync to the Pi acts on that folder instead, and the service is a LaunchAgent in place
# of the systemd unit. Same build, same stamps, same targets, same gates.
PI_ROOT="${PI_ROOT:-}"
[[ -n "$PI_ROOT" && -z "${PI_HOST:-}" ]] && PI_HOST="localhost"

if [[ -z "${PI_HOST:-}" || -z "${PI_USER:-}" ]]; then
    if [[ "$BUILD_ONLY" == "1" ]]; then
        PI_HOST="build-only-placeholder.invalid"
        PI_USER="build-only-placeholder"
        PI_CONFIG_PLACEHOLDER=1
    else
        echo -e "\033[0;31m[ERROR]\033[0m deploy.config must set PI_HOST and PI_USER"
        exit 1
    fi
fi

PI_TARGET="${PI_USER}@${PI_HOST}"
set_paths() {
    INSTALL_DIR="${PI_ROOT}/home/${PI_USER}/win95"
    DEV_INSTALL_DIR="${PI_ROOT}/home/${PI_USER}/win95-dev"
    INPUTS_DIR="${PI_ROOT}/home/${PI_USER}/win95-deploy-inputs"
}
set_paths
if [[ -n "$PI_ROOT" ]]; then
    SITE_URL="http://win95.localhost:${SITE_PORT}/"; DEV_URL="http://win95-dev.localhost:${SITE_PORT}/"
else
    SITE_URL="https://win95.funstuff.app/"; DEV_URL="https://win95-dev.funstuff.app/"
fi
LAUNCH_LABEL="app.funstuff.win95"
LAUNCH_PLIST="${HOME}/Library/LaunchAgents/${LAUNCH_LABEL}.plist"

# The Pi: a shell command there, and an rsync destination there (ssh to PI_TARGET, or PI_ROOT on this machine).
on_pi() {
    if [[ -n "$PI_ROOT" ]]; then bash -c "$1"; else ssh -o ConnectTimeout=5 "$PI_TARGET" "$1"; fi
}
pi_dest() {
    if [[ -n "$PI_ROOT" ]]; then printf '%s' "$1"; else printf '%s:%s' "$PI_TARGET" "$1"; fi
}

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

require_real_pi_config() {
    if [[ "${PI_CONFIG_PLACEHOLDER:-0}" == "1" ]]; then
        log_error "PI_HOST/PI_USER are --build-only placeholders (no deploy.config found)."
        log_error "This operation contacts the Pi and requires a real deploy.config."
        exit 1
    fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Build metadata, stamped at build time
# index.html carries <meta name="build-*"> tags; the source copy (what
# localhost serves) reads as a dev build of the working tree. The staged copy
# gets this build's values: channel (dev | prod), sig (<ver>+<sha>), version
# (2-37 -> 2.3.7), commit, date. index.html reads them as text for the dev
# banner and the [DEV <sig>] title (dev channel only). Values are
# regex-validated here (and in require_deploy_signature), so only digits,
# dots, dashes, plus signs and hex reach the page.
# ─────────────────────────────────────────────────────────────────────────────
stamp_build_meta() {
    local idx="$STAGING_DIR/site/index.html"
    local channel="dev" sig version commit="" date
    [[ "${PROD_DEPLOY:-0}" == "1" ]] && channel="prod"
    date="$(date -u +%Y-%m-%d)"
    if [[ -n "$DEPLOY_VERSION" && -n "$DEPLOY_COMMIT" ]]; then
        local major="${DEPLOY_VERSION%%-*}" mi="${DEPLOY_VERSION#*-}"
        version="${major}.${mi:0:1}.${mi:1:1}"
        commit="${DEPLOY_COMMIT:0:7}"
        sig="$DEPLOY_SIG"
    else
        version="build-$(date -u +%Y%m%dT%H%MZ)"
        sig="$version"
    fi
    local v
    for v in "$channel" "$sig" "$version" "$commit" "$date"; do
        if ! [[ "$v" =~ ^[A-Za-z0-9.+-]*$ ]]; then
            log_error "Build metadata value '$v' has characters outside [A-Za-z0-9.+-]. Refusing to build."
            exit 1
        fi
    done
    local tmp="$idx.tmp"
    B_CHANNEL="$channel" B_SIG="$sig" B_VERSION="$version" B_COMMIT="$commit" B_DATE="$date" \
        perl -pe '
            s/(<meta name="build-channel" content=")[^"]*(")/$1$ENV{B_CHANNEL}$2/;
            s/(<meta name="build-sig" content=")[^"]*(")/$1$ENV{B_SIG}$2/;
            s/(<meta name="build-version" content=")[^"]*(")/$1$ENV{B_VERSION}$2/;
            s/(<meta name="build-commit" content=")[^"]*(")/$1$ENV{B_COMMIT}$2/;
            s/(<meta name="build-date" content=")[^"]*(")/$1$ENV{B_DATE}$2/;
        ' "$idx" > "$tmp" && mv "$tmp" "$idx"
    if ! grep -qF "<meta name=\"build-channel\" content=\"${channel}\" />" "$idx" \
        || ! grep -qF "<meta name=\"build-sig\" content=\"${sig}\" />" "$idx"; then
        log_error "Build metadata was not stamped into the staged index.html. Refusing to build."
        exit 1
    fi
    log_info "Build metadata: ${channel} ${sig} (version ${version}${commit:+, ${commit}}, ${date})"
}

# ─────────────────────────────────────────────────────────────────────────────
# Cache busting: every script URL carries this deploy's signature
#
# A browser that keeps a cached copy of one script and fetches a new copy of
# another runs a mix of two builds. Stamp every script URL with this deploy's
# signature: the page's <script src>, host-web.js's win95.js, the machine's new Worker('worker.js'),
# the worker's importScripts list and the service worker's registration, and
# name the service worker's cache after it, so a new build replaces the cache
# rather than layering on it.
# ─────────────────────────────────────────────────────────────────────────────
cache_bust_site() {
    log_info "Stamping every script URL with ?v=${DEPLOY_SIG}..."
    local site="$STAGING_DIR/site" cb="v=${DEPLOY_SIG}"

    patch_file() {
        local file="$1"
        shift
        local tmp="${file}.tmp"
        CB="$cb" SIG="$DEPLOY_SIG" perl -pe "$@" "$file" > "$tmp" && mv "$tmp" "$file"
    }

    patch_file "$site/index.html" \
        's|(<script src="[A-Za-z0-9_./-]+\.js)(?:\?v=[A-Za-z0-9_.+-]*)?"|$1?$ENV{CB}"|g; s|register\(\x27sw\.js(?:\?v=[A-Za-z0-9_.+-]*)?\x27\)|register(\x27sw.js?$ENV{CB}\x27)|g'
    # (host-web.js is its own file, or packed into app.js: bundle_site)
    local hw="$site/host-web.js"; [[ -f "$hw" ]] || hw="$site/app.js"
    patch_file "$hw" \
        's|\.src = \x27win95\.js(?:\?v=[A-Za-z0-9_.+-]*)?\x27|.src = \x27win95.js?$ENV{CB}\x27|g'
    patch_file "$site/win95.js" \
        's|new Worker\(\x27worker\.js(?:\?v=[A-Za-z0-9_.+-]*)?\x27\)|new Worker(\x27worker.js?$ENV{CB}\x27)|g'
    patch_file "$site/worker.js" \
        'if (/^importScripts\(/) { s|\x27([A-Za-z0-9_.-]+\.js)(?:\?v=[A-Za-z0-9_.+-]*)?\x27|\x27$1?$ENV{CB}\x27|g }'
    patch_file "$site/sw.js" \
        's|^const CACHE = .*;$|const CACHE = \x27win95-$ENV{SIG}\x27;|'

    # Every script reference must now carry the signature; a missed one would run a cached copy.
    local bad=0 n
    n="$(grep -oE '<script src="[^"]+"' "$site/index.html" | grep -vcF "?${cb}\"" || true)"
    [[ "$n" == "0" ]] || { log_error "index.html: $n <script src> without ?${cb}"; bad=1; }
    grep -qF "register('sw.js?${cb}')" "$site/index.html" || { log_error "index.html: sw.js registration not stamped"; bad=1; }
    grep -qF "new Worker('worker.js?${cb}')" "$site/win95.js" || { log_error "win95.js: new Worker('worker.js') not stamped"; bad=1; }
    grep -qF ".src = 'win95.js?${cb}'" "$hw" || { log_error "$(basename "$hw"): win95.js load not stamped"; bad=1; }
    n="$(grep -E '^importScripts\(' "$site/worker.js" | grep -oE "'[^']+\.js[^']*'" | grep -vcF "?${cb}'" || true)"
    [[ "$n" == "0" ]] || { log_error "worker.js: $n importScripts entries without ?${cb}"; bad=1; }
    grep -qF "const CACHE = 'win95-${DEPLOY_SIG}';" "$site/sw.js" || { log_error "sw.js: cache name not stamped"; bad=1; }
    if [[ $bad -ne 0 ]]; then
        log_error "Cache busting incomplete. Refusing to build."
        exit 1
    fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Parse arguments
# ─────────────────────────────────────────────────────────────────────────────
DRY_RUN=0
PROD_DEPLOY=0
FILES_ONLY=0
SETUP_ONLY=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --build-only) BUILD_ONLY=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        --dev) shift ;;
        --prod) PROD_DEPLOY=1; shift ;;
        --files-only) FILES_ONLY=1; shift ;;
        --setup-only) SETUP_ONLY=1; shift ;;
        --commit) DEPLOY_COMMIT="$2"; shift 2 ;;
        --version) DEPLOY_VERSION="$2"; shift 2 ;;
        --host) PI_HOST="$2"; PI_TARGET="${PI_USER}@${PI_HOST}"; shift 2 ;;
        --user) PI_USER="$2"; PI_TARGET="${PI_USER}@${PI_HOST}"; set_paths; shift 2 ;;
        -h|--help)
            echo "Usage: $0 --commit <short-sha> --version <ver> [OPTIONS]"
            echo ""
            echo "Required for any deploy (dev or prod):"
            echo "  --commit SHA        Short hash of the commit being shipped. Verified against the"
            echo "                      checkout's .git/HEAD (read as files; this script never runs git)."
            echo "                      Get it with:  git rev-parse --short HEAD"
            echo "  --version VER       <MAJOR>-<M><I>. MAJOR any integer; dash; then EXACTLY two digits,"
            echo "                      minor and iteration, one digit each, concatenated (not added)."
            echo "                        0-01 = v0.0.1    1-11 = v1.1.1    1-1 / 1-111 / 1.1.1 = invalid"
            echo "                      The signature is <ver>+<sha>, e.g. 0-01+e2189dc; it becomes every"
            echo "                      script's ?v= and the dev title bar: [DEV 0-01+e2189dc]"
            echo ""
            echo "Target (default is DEV):"
            echo "  (none) / --dev      Site files only -> /home/<user>/win95-dev/site, served at"
            echo "                      win95-dev.funstuff.app by the SAME service. No restart."
            echo "  --prod              Production files + service. ALSO requires W95_ALLOW_PROD=1."
            echo ""
            echo "Options:"
            echo "  --build-only        Build the staging dir only: no ssh/rsync/service, no deploy.config needed"
            echo "  --dry-run           Preview the file sync (rsync --dry-run) for the chosen target; writes nothing"
            echo "  --files-only        (--prod) Only sync files, don't touch the service"
            echo "  --setup-only        (--prod) Only set up the service (assumes files already deployed)"
            echo "  --host HOST         Override PI_HOST from deploy.config"
            echo "  --user USER         Override PI_USER from deploy.config"
            exit 0
            ;;
        *) log_error "Unknown argument: $1"; exit 1 ;;
    esac
done

# ─────────────────────────────────────────────────────────────────────────────
# Deploy signature check (--commit / --version)
# ─────────────────────────────────────────────────────────────────────────────
resolve_head_sha() {
    local gd="$REPO_ROOT/.git"
    if [[ -f "$gd" ]]; then
        gd="$(sed -n 's/^gitdir: //p' "$gd")"
        [[ "$gd" == /* ]] || gd="$REPO_ROOT/$gd"
    fi
    [[ -f "$gd/HEAD" ]] || return 1
    local head; head="$(cat "$gd/HEAD")"
    if [[ "$head" != ref:* ]]; then
        echo "$head"; return 0
    fi
    local ref="${head#ref: }"
    local common="$gd"
    if [[ -f "$gd/commondir" ]]; then
        common="$(cat "$gd/commondir")"
        [[ "$common" == /* ]] || common="$gd/$common"
    fi
    if [[ -f "$common/$ref" ]]; then cat "$common/$ref"; return 0; fi
    if [[ -f "$gd/$ref" ]]; then cat "$gd/$ref"; return 0; fi
    if [[ -f "$common/packed-refs" ]]; then
        local line; line="$(grep " ${ref}\$" "$common/packed-refs" | head -n1)"
        [[ -n "$line" ]] && { echo "${line%% *}"; return 0; }
    fi
    return 1
}

require_deploy_signature() {
    if [[ -z "$DEPLOY_COMMIT" || -z "$DEPLOY_VERSION" ]]; then
        log_error "A deploy needs BOTH --commit <short-sha> and --version <ver>. Nothing was done."
        log_error "  commit:   git rev-parse --short HEAD"
        log_error "  version:  <MAJOR>-<M><I>, e.g. 0-01 (v0.0.1)"
        exit 1
    fi
    if ! [[ "$DEPLOY_COMMIT" =~ ^[0-9a-f]{7,40}$ ]]; then
        log_error "--commit '$DEPLOY_COMMIT' is not a hex sha of 7-40 chars. Nothing was done."
        exit 1
    fi
    if ! [[ "$DEPLOY_VERSION" =~ ^[0-9]+-[0-9][0-9]$ ]]; then
        log_error "--version '$DEPLOY_VERSION' must be <MAJOR>-<M><I>: e.g. 0-01 (v0.0.1), 1-11 (v1.1.1). Nothing was done."
        log_error "MAJOR is any integer; after the dash EXACTLY two digits: minor then iteration, one digit each."
        exit 1
    fi
    DEPLOY_SIG="${DEPLOY_VERSION}+${DEPLOY_COMMIT}"
    local head_sha
    if ! head_sha="$(resolve_head_sha)"; then
        log_error "Could not resolve HEAD from $REPO_ROOT/.git. Nothing was done."
        exit 1
    fi
    if [[ "$head_sha" != "$DEPLOY_COMMIT"* ]]; then
        log_error "--commit $DEPLOY_COMMIT does not match the checkout's HEAD (${head_sha:0:12})."
        log_error "You are not deploying what you think you are. Nothing was done."
        exit 1
    fi
    log_info "Deploy signature: commit ${DEPLOY_COMMIT} (HEAD ${head_sha:0:12}), sig ${DEPLOY_SIG}"
}

# Every generated bundle starts with the provenance line its generator wrote (tools/provenance.py): the tool files
# that made it and a hash of their bytes. A bundle the checkout's tools would not make (built before a change to its
# generator or the recompiler, or with no provenance at all) is not shipped: rebuild it first.
require_current_bundles() {
    local f line files want have bad=0
    for f in "${GENERATED[@]}"; do
        [[ "$f" == assets.js ]] && continue   # (hand-assembled from extract.py's output: no generator)
        line="$(head -n 1 "$REPO_ROOT/$f")"
        if [[ "$line" != "// tools: "*" sha256="* ]]; then
            log_error "$f has no provenance line: built before tools/provenance.py. Rebuild it."
            bad=1; continue
        fi
        files="${line#// tools: }"; files="${files%% sha256=*}"; want="${line##* sha256=}"
        have="$(cd "$REPO_ROOT" && python3 tools/provenance.py "$files")"
        if [[ "$have" != "$want" ]]; then
            log_error "$f was built by other tools than this checkout's (${files}). Rebuild it."
            bad=1
        fi
    done
    if [[ $bad -ne 0 ]]; then
        log_error "Stale generated bundles. Nothing was built."
        exit 1
    fi
    log_info "Generated bundles match this checkout's tools."
}

# Copy one file into the staging tree: a real copy, never a link. Big generated files (system.js is ~140 MB, the CD
# image ~600 MB) are cloned where the filesystem can (APFS clonefile, a reflink on Linux), a plain copy otherwise.
stage_file() {
    local src="$1" dst="$2"
    if [[ -L "$src" ]]; then
        log_error "$src is a symlink; deploy inputs are copied files. Refusing to build."
        exit 1
    fi
    cp -c "$src" "$dst" 2>/dev/null || cp --reflink=auto "$src" "$dst" 2>/dev/null || cp "$src" "$dst"
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Build/stage files locally
# ─────────────────────────────────────────────────────────────────────────────
# The page's hand-written scripts packed into one file each for the page (app.js) and the worker (worker-libs.js),
# in the order they were loaded, so the browser fetches two scripts in place of forty: the generated bundles (data,
# window.W95SYSTEM and the like, hundreds of megabytes together) stay their own files, loaded first, so each is cached
# on its own. The single files are read by every tag or importScripts entry the stamps then sign. A hand-written
# script that was loaded after a generated one reads the generated one's globals only at run time (makeDisk,
# W95SAV in the saver runtime), never as it loads, so the order of the two kinds does not matter; among the
# hand-written ones it is kept. win95.js stays its own file (host-web.js loads it once the store is open), sw.js too.
bundle_site() {
    [[ "${W95_NO_BUNDLE:-}" == 1 ]] && return 0
    local site="$STAGING_DIR/site" idx="$STAGING_DIR/site/index.html"
    local gen=" ${GENERATED[*]} msdos.js "
    # the page: its <script src> tags in order, split into the generated ones (kept) and the hand-written ones (packed)
    local tags hand=() keep=() f
    tags="$(grep -oE '<script src="[A-Za-z0-9_./-]+\.js"' "$idx" | sed -E 's/<script src="(.*)"/\1/')"
    for f in $tags; do
        if [[ "$gen" == *" $f "* ]]; then keep+=("$f"); else hand+=("$f"); fi
    done
    : > "$site/app.js"
    for f in "${hand[@]}"; do { cat "$site/$f"; printf '\n;\n'; } >> "$site/app.js"; done
    # the tags: the generated ones as they were, then one for app.js; the hand-written ones' tags removed
    local tmp="$idx.tmp"
    HAND="${hand[*]}" perl -pe '
        BEGIN { %h = map { $_ => 1 } split / /, $ENV{HAND}; $done = 0 }
        if (/^<script src="([A-Za-z0-9_.\/-]+\.js)"/ && $h{$1}) { $_ = $done++ ? "" : "<script src=\"app.js\"></script>\n"; }
    ' "$idx" > "$tmp" && mv "$tmp" "$idx"
    # (app.js goes after the last generated tag: the line it took is the first hand-written one's, moved past them)
    python3 - "$idx" "${keep[@]}" <<'PY'
import re, sys
p, keep = sys.argv[1], sys.argv[2:]
s = open(p).read()
app = '<script src="app.js"></script>\n'
s = s.replace(app, '', 1)
last = None
for k in keep:
    m = re.search(r'<script src="%s"[^>]*></script>\n' % re.escape(k), s)
    if m and (last is None or m.end() > last): last = m.end()
s = s[:last] + app + s[last:] if last is not None else s.replace('<body>\n', '<body>\n' + app, 1)
open(p, 'w').write(s)
PY
    # the worker: its importScripts entries the same way, into worker-libs.js (the files both read go once both have)
    local wk="$site/worker.js" imports whand=() wkeep=()
    imports="$(grep -E '^importScripts\(' "$wk" | grep -oE "'[A-Za-z0-9_.-]+\.js'" | tr -d "'")"
    for f in $imports; do
        if [[ "$gen" == *" $f "* ]]; then wkeep+=("$f"); else whand+=("$f"); fi
    done
    : > "$site/worker-libs.js"
    for f in "${whand[@]}"; do { cat "$site/$f"; printf '\n;\n'; } >> "$site/worker-libs.js"; done
    local line="importScripts(" sep=""
    for f in "${wkeep[@]}" worker-libs.js; do line+="${sep}'$f'"; sep=", "; done
    line+=");"
    LINE="$line" perl -pe 'if (/^importScripts\(/) { $_ = "$ENV{LINE}\n" }' "$wk" > "$wk.tmp" && mv "$wk.tmp" "$wk"
    for f in "${hand[@]}" "${whand[@]}"; do rm -f "$site/$f"; done
    log_info "Packed ${#hand[@]} page scripts into app.js and ${#whand[@]} worker scripts into worker-libs.js"
}

# terser, as the dustytrails deploy runs it, over the staged hand-written scripts (the tracked top-level .js; the
# generated bundles are untracked and left as they are). After the stamps, whose checks look for the sources' quoting.
# A file terser fails on stays as it was.
TERSER_FLAGS=(--compress --mangle)
minify_site() {
    [[ "${W95_NO_MINIFY:-}" == 1 ]] && return 0
    if ! command -v terser >/dev/null 2>&1; then
        log_warn "terser not found: scripts are served unminified (npm i -g terser)"
        return 0
    fi
    log_info "Minifying scripts (terser ${TERSER_FLAGS[*]})..."
    # (the tracked top-level scripts still in the site, and the packed ones)
    local list before after
    list="$( { cd "$REPO_ROOT" && git ls-files -- '*.js' | grep -v /; echo app.js; echo worker-libs.js; } | while read -r f; do [[ -f "$STAGING_DIR/site/$f" ]] && echo "$f"; done)"
    before="$(cat $(echo "$list" | sed "s|^|$STAGING_DIR/site/|") | wc -c)"
    echo "$list" | xargs -P 8 -I{} sh -c '
        f="$1/site/{}"; t="$f.min"
        if terser "$f" '"${TERSER_FLAGS[*]}"' -o "$t" 2>/dev/null && [ -s "$t" ]; then mv "$t" "$f"; else rm -f "$t"; echo "  not minified: {}"; fi' _ "$STAGING_DIR"
    after="$(cat $(echo "$list" | sed "s|^|$STAGING_DIR/site/|") | wc -c)"
    log_info "Scripts: $before -> $after bytes"
}

build_staging() {
    if [[ -z "$DEPLOY_SIG" ]]; then
        DEPLOY_SIG="$(date +%s)"
    fi
    log_step "Building staging directory..."

    rm -rf "$STAGING_DIR"
    mkdir -p "$STAGING_DIR/site/icons"

    # The served tree: ALL top-level .js by glob (an explicit list silently drops new files), the page, its manifest
    # and icons, the generated bundles and the CD image. No tests, tools, bench, electron or mac.
    local f missing=0
    for f in "${GENERATED[@]}" "$CD_IMAGE"; do
        if [[ ! -e "$REPO_ROOT/$f" ]]; then
            log_error "Missing generated input: $REPO_ROOT/$f"
            missing=1
        fi
    done
    if [[ $missing -ne 0 ]]; then
        log_error "Generate them (tools/build_*.py, extract.py) or copy them from $INPUTS_DIR. Nothing was built."
        exit 1
    fi
    require_current_bundles
    log_info "Copying site files..."
    for f in "$REPO_ROOT/"*.js; do
        stage_file "$f" "$STAGING_DIR/site/$(basename "$f")"
    done
    cp "$REPO_ROOT/index.html" "$REPO_ROOT/manifest.webmanifest" "$STAGING_DIR/site/"
    # (the page's own test tools, loaded by a tab with ?debug=1: the sketcher, the fuzzer over real machines)
    mkdir -p "$STAGING_DIR/site/tools/convolution"
    cp "$REPO_ROOT/tools/sketch.mjs" "$STAGING_DIR/site/tools/" && cp "$REPO_ROOT/tools/convolution/fuzz-tabs.mjs" "$STAGING_DIR/site/tools/convolution/"
    cp "$REPO_ROOT/icons/"*.png "$STAGING_DIR/site/icons/"
    # (Discord's Embedded App SDK, which discord.js imports in Discord's frame only: served from this origin)
    if [[ -e "$REPO_ROOT/vendor/embedded-app-sdk.js" ]]; then
        mkdir -p "$STAGING_DIR/site/vendor" && stage_file "$REPO_ROOT/vendor/embedded-app-sdk.js" "$STAGING_DIR/site/vendor/embedded-app-sdk.js"
    else
        log_warn "No vendor/embedded-app-sdk.js: the page in Discord's frame starts as Guest (discord.js)"
    fi
    stage_file "$REPO_ROOT/$CD_IMAGE" "$STAGING_DIR/site/$CD_IMAGE"
    # The audio CD in the second CD drive (tools/build_audiocd.py): the page needs it
    for f in audiocd.bin audiocd.json; do
        stage_file "$REPO_ROOT/$f" "$STAGING_DIR/site/$f"
    done

    # The scripts the stamps rewrite are copies, never links into the working tree.
    for f in index.html host-web.js win95.js worker.js sw.js; do
        cp "$REPO_ROOT/$f" "$STAGING_DIR/site/$f.fresh" && mv "$STAGING_DIR/site/$f.fresh" "$STAGING_DIR/site/$f"
    done

    # The bundles in two parts (tools/split_system.py): the staged system.js and savers.js without their recompiled
    # code, which goes into system-code.js. The page starts from the first part; the code is fetched behind it
    # (host-web.js) and taken by each machine's worker (worker.js), both by this build's stamp.
    log_info "Splitting the recompiled code from what the page starts with..."
    python3 "$REPO_ROOT/tools/split_system.py" --code "$STAGING_DIR/site/system-code.js" "$STAGING_DIR/site/system.js" "$STAGING_DIR/site/savers.js"

    bundle_site
    cache_bust_site
    stamp_build_meta
    minify_site

    # Server and unit, outside the served tree
    cp "$SCRIPT_DIR/win95_server.py" "$SCRIPT_DIR/win95.service" "$REPO_ROOT/tools/sessions.py" "$REPO_ROOT/tools/claude_api.py" "$REPO_ROOT/tools/discord_api.py" "$STAGING_DIR/"
    # The public names' share (win95_server.py PUBLIC_SHARES), outside the served tree too
    rm -rf "$STAGING_DIR/share" && cp -R "$SCRIPT_DIR/share" "$STAGING_DIR/share"

    log_info "Staging complete: $(du -sh "$STAGING_DIR" | cut -f1)"
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Deploy files to Pi (production)
# ─────────────────────────────────────────────────────────────────────────────
deploy_files() {
    require_real_pi_config
    log_step "Deploying to $(pi_dest "$INSTALL_DIR")..."
    require_pi
    if [[ "${DRY_RUN:-0}" == "1" ]]; then
        log_warn "DRY RUN — rsync --dry-run: previewing changes, writing nothing."
        rsync -av --dry-run --itemize-changes --delete "$STAGING_DIR/site/" "$(pi_dest "$INSTALL_DIR/site/")"
        rsync -av --dry-run --itemize-changes "$STAGING_DIR/win95_server.py" "$STAGING_DIR/sessions.py" "$STAGING_DIR/claude_api.py" "$STAGING_DIR/discord_api.py" "$(pi_dest "$INSTALL_DIR/")"
        rsync -av --dry-run --itemize-changes --delete "$STAGING_DIR/share/" "$(pi_dest "$INSTALL_DIR/share/")"
        return 0
    fi
    on_pi "mkdir -p '$INSTALL_DIR/site' '$INSTALL_DIR/share'"
    # --delete is safe: site/ and share/ are created and owned by this script and hold nothing hand-placed.
    rsync -av --delete "$STAGING_DIR/site/" "$(pi_dest "$INSTALL_DIR/site/")"
    rsync -av --delete "$STAGING_DIR/share/" "$(pi_dest "$INSTALL_DIR/share/")"
    rsync -av "$STAGING_DIR/win95_server.py" "$STAGING_DIR/sessions.py" "$STAGING_DIR/claude_api.py" "$STAGING_DIR/discord_api.py" "$(pi_dest "$INSTALL_DIR/")"
    log_info "Files deployed to $(pi_dest "$INSTALL_DIR")"
    install_claude_key
}

# The Claude API key the service reads (tools/claude_api.py: ~/.config/win95/anthropic-api-key and -workspace-id of
# the user it runs as): this machine's copy goes to the Pi user's home, owner-readable only, when the Pi is a real
# one. Under PI_ROOT the service runs as this user and reads this machine's own files, so nothing is copied. The
# key never goes into the site or the server's files.
install_claude_key() {
    local src="$HOME/.config/win95" f
    [[ -n "$PI_ROOT" ]] && { log_info "Claude API key: the service reads $src itself (PI_ROOT)"; return 0; }
    [[ -f "$src/anthropic-api-key" ]] || { log_warn "No $src/anthropic-api-key here: the Pi's service has no Claude API key unless one is there already"; return 0; }
    on_pi "mkdir -p ~/.config/win95 && chmod 700 ~/.config/win95"
    for f in anthropic-api-key anthropic-workspace-id; do
        [[ -f "$src/$f" ]] || continue
        rsync -a --chmod=F600 "$src/$f" "$PI_TARGET:.config/win95/$f"
    done
    log_info "Claude API key installed in ~/.config/win95 on the Pi"
}

# The Pi answers (ssh), or PI_ROOT is a folder laid out as the Pi's home.
require_pi() {
    if [[ -n "$PI_ROOT" ]]; then
        if [[ ! -d "$PI_ROOT/home/$PI_USER" ]]; then
            log_error "PI_ROOT $PI_ROOT has no home/$PI_USER (create the Pi's home there first)"
            exit 1
        fi
    elif ! ssh -o ConnectTimeout=5 "$PI_TARGET" "echo 'SSH OK'" &>/dev/null; then
        log_error "Cannot connect to $PI_TARGET"
        exit 1
    fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 2-dev: site-only sync to the dev tree (the default)
#
# win95-dev.funstuff.app is NOT a second deployment: the same win95 service
# resolves a different site root when the Host header is DEV_HOST. So this
# ships static files and nothing else: source is ALWAYS $STAGING_DIR/site/
# (no .py in it), destination is ALWAYS $DEV_INSTALL_DIR/site/, and there is
# no service setup or restart: the running service reads files per request.
# ─────────────────────────────────────────────────────────────────────────────
deploy_dev_files() {
    require_real_pi_config
    log_step "Deploying SITE ONLY to $(pi_dest "$DEV_INSTALL_DIR/site")..."
    require_pi
    local src="$STAGING_DIR/site"
    if find "$src" -maxdepth 1 -name '*.py' | grep -q .; then
        log_error "Staged site dir contains .py files — refusing a dev deploy."
        exit 1
    fi
    if ! grep -qF '<meta name="build-channel" content="dev" />' "$src/index.html" \
        || ! grep -qF "<meta name=\"build-sig\" content=\"${DEPLOY_SIG}\" />" "$src/index.html"; then
        log_error "Staged index.html is not stamped as dev build ${DEPLOY_SIG}. Refusing to ship."
        exit 1
    fi
    if [[ "${DRY_RUN:-0}" == "1" ]]; then
        log_warn "DRY RUN — previewing the dev site sync, writing nothing."
        rsync -av --dry-run --itemize-changes --delete "$src/" "$(pi_dest "$DEV_INSTALL_DIR/site/")"
        return 0
    fi
    on_pi "mkdir -p '$DEV_INSTALL_DIR/site'"
    rsync -av --delete "$src/" "$(pi_dest "$DEV_INSTALL_DIR/site/")"
    log_info "Dev site deployed to $(pi_dest "$DEV_INSTALL_DIR/site")"
    log_info "Production install at $INSTALL_DIR was not touched."
    log_info "No service restart needed — files are read per request."
}

# ─────────────────────────────────────────────────────────────────────────────
# Health gate — did the service actually come back? Probed ON THE PI over
# ssh against 127.0.0.1 (the service binds loopback only), one ssh for the
# whole poll loop, with the restart counter checked for a restart loop.
# Detect and report only — no rollback.
# ─────────────────────────────────────────────────────────────────────────────
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-1}"

# The service's state and restart count: systemd on the Pi, the LaunchAgent under PI_ROOT.
service_active() {
    if [[ -n "$PI_ROOT" ]]; then
        launchctl print "gui/$(id -u)/${LAUNCH_LABEL}" 2>/dev/null | grep -q 'state = running' && echo active || echo inactive
    else
        on_pi "systemctl is-active ${SERVICE_NAME}" 2>/dev/null | tr -d '[:space:]' || true
    fi
}
service_restarts() {
    if [[ -n "$PI_ROOT" ]]; then
        launchctl print "gui/$(id -u)/${LAUNCH_LABEL}" 2>/dev/null | sed -n 's/^[[:space:]]*runs = \([0-9]*\)$/\1/p' | head -1
    else
        on_pi "systemctl show ${SERVICE_NAME} -p NRestarts --value" 2>/dev/null | tr -dc '0-9' || true
    fi
}
service_log() {
    if [[ -n "$PI_ROOT" ]]; then
        tail -n 30 "$INSTALL_DIR/win95.log" 2>/dev/null || echo '(log unavailable)'
    else
        on_pi "journalctl -u ${SERVICE_NAME} -n 30 --no-pager 2>/dev/null || echo '(journal unavailable)'"
    fi
}

wait_for_service_health() {
    require_real_pi_config
    local url="http://127.0.0.1:${SITE_PORT}/ (probed on the Pi)"
    log_step "Health check: waiting up to ${HEALTH_TIMEOUT}s for $SERVICE_NAME on $url"
    local restarts_before
    restarts_before="$(service_restarts)"
    # (launchd counts the first start as a run; systemd's NRestarts does not)

    local probe_out probe_env="HEALTH_PORT=${SITE_PORT} HEALTH_DEADLINE=${HEALTH_TIMEOUT} HEALTH_INTERVAL=${HEALTH_INTERVAL}"
    probe_out="$(if [[ -n "$PI_ROOT" ]]; then env $probe_env bash -s; else ssh -o ConnectTimeout=5 "$PI_TARGET" "$probe_env bash -s"; fi 2>/dev/null <<'REMOTE_PROBE'
set -u
if ! command -v curl >/dev/null 2>&1; then echo "NOCURL 000 0"; exit 0; fi
start=$(date +%s); deadline=$(( start + HEALTH_DEADLINE )); code=000
while : ; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${HEALTH_PORT}/" 2>/dev/null || true)
    [ -n "$code" ] || code=000
    [ "$code" = "200" ] && break
    [ "$(date +%s)" -ge "$deadline" ] && break
    sleep "$HEALTH_INTERVAL"
done
echo "PROBE $code $(( $(date +%s) - start ))"
REMOTE_PROBE
)" || true
    local line kind="NORESULT" code="000"
    line="$(printf '%s\n' "$probe_out" | grep -E '^(PROBE|NOCURL) ' | tail -1)" || true
    if [[ -n "$line" ]]; then kind="${line%% *}"; code="$(echo "$line" | cut -d' ' -f2)"; fi

    local active restarts_after problems=""
    active="$(service_active)"
    restarts_after="$(service_restarts)"
    case "$kind" in
        NOCURL) problems="${problems}
HTTP probe COULD NOT RUN: curl is not installed on the Pi." ;;
        NORESULT) problems="${problems}
HTTP probe COULD NOT RUN: no result line came back over ssh from ${PI_TARGET}." ;;
        *) [[ "$code" == "200" ]] || problems="${problems}
${url} never returned 200 within ${HEALTH_TIMEOUT}s (last HTTP status: ${code})" ;;
    esac
    [[ "$active" == "active" ]] || problems="${problems}
the service reports '${active:-unknown}', expected 'active'"
    if [[ -n "$restarts_before" && -n "$restarts_after" ]] && (( 10#$restarts_after > 10#$restarts_before )); then
        problems="${problems}
NRestarts climbed ${restarts_before} -> ${restarts_after} during the probe window — the unit is restart-looping"
    fi
    if [[ -n "$problems" ]]; then
        log_error "Health check FAILED for ${SERVICE_NAME}:"
        local p
        while IFS= read -r p; do [[ -n "$p" ]] && log_error "  - $p"; done <<< "$problems"
        service_log 2>&1 | sed 's/^/        /' || true
        log_error "The new files are on the Pi and were NOT rolled back."
        exit 1
    fi
    log_info "Health check passed: ${SERVICE_NAME} is active and served 200 at ${url}."
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Setup service on Pi (production)
# ─────────────────────────────────────────────────────────────────────────────
run_remote_script_tty() {
    local local_path="$1" name="$2"
    local remote_path="/tmp/win95-${name}-$$.sh"
    scp -q "$local_path" "$PI_TARGET:$remote_path" || return 1
    ssh -t "$PI_TARGET" "bash '$remote_path'; rc=\$?; rm -f '$remote_path'; exit \$rc"
}

# PI_ROOT: the service is a LaunchAgent running the same server from the same install dir, in place of the unit.
setup_local_service() {
    log_step "Setting up the LaunchAgent ${LAUNCH_LABEL} for ${INSTALL_DIR}..."
    mkdir -p "$INPUTS_DIR" "$DEV_INSTALL_DIR/site" "$(dirname "$LAUNCH_PLIST")"
    local py; py="$(command -v python3)"
    cat > "$LAUNCH_PLIST.tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${py}</string>
    <string>${INSTALL_DIR}/win95_server.py</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>${SITE_PORT}</string>
  </array>
  <key>WorkingDirectory</key><string>${INSTALL_DIR}</string>
  <key>EnvironmentVariables</key><dict><key>PYTHONUNBUFFERED</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${INSTALL_DIR}/win95.log</string>
  <key>StandardErrorPath</key><string>${INSTALL_DIR}/win95.log</string>
</dict>
</plist>
PLIST
    mv "$LAUNCH_PLIST.tmp" "$LAUNCH_PLIST"
    local dom="gui/$(id -u)"
    launchctl bootout "$dom/${LAUNCH_LABEL}" 2>/dev/null || true
    # (bootout returns before the service is gone; bootstrapping it while it is still there fails with error 5)
    while launchctl print "$dom/${LAUNCH_LABEL}" >/dev/null 2>&1; do sleep 0.2; done
    launchctl bootstrap "$dom" "$LAUNCH_PLIST"
    launchctl kickstart -k "$dom/${LAUNCH_LABEL}"
    log_info "Service setup complete!"
    wait_for_service_health
}

setup_service() {
    require_real_pi_config
    if [[ -n "$PI_ROOT" ]]; then setup_local_service; return; fi
    log_step "Setting up service on Pi..."
    local svc_tmp; svc_tmp="$(mktemp)"
    sed -e "s|__USER__|${PI_USER}|g" "$SCRIPT_DIR/win95.service" > "$svc_tmp"
    scp -q "$svc_tmp" "$PI_TARGET:$INSTALL_DIR/win95.service"
    rm -f "$svc_tmp"

    log_info "Installing systemd service (may prompt for password)..."
    local sudo_tmp; sudo_tmp="$(mktemp)"
    cat > "$sudo_tmp" <<REMOTE_SUDO
set -e
mkdir -p "$INPUTS_DIR" "$DEV_INSTALL_DIR/site"
sudo cp "$INSTALL_DIR/win95.service" /etc/systemd/system/win95.service
sudo systemctl daemon-reload
sudo systemctl enable win95
sudo systemctl restart win95
SUDOERS_LINE="${PI_USER} ALL=(ALL) NOPASSWD: /usr/bin/systemctl daemon-reload, /usr/bin/systemctl restart win95, /usr/bin/systemctl start win95, /usr/bin/systemctl stop win95, /usr/bin/systemctl status win95 *, /usr/bin/journalctl -u win95 *"
echo "\$SUDOERS_LINE" | sudo tee /etc/sudoers.d/win95-deploy > /dev/null
sudo chmod 440 /etc/sudoers.d/win95-deploy
sleep 2
sudo systemctl status win95 --no-pager || true
REMOTE_SUDO
    run_remote_script_tty "$sudo_tmp" "deploy_service"
    rm -f "$sudo_tmp"
    log_info "Service setup complete!"
    wait_for_service_health
}

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────
main() {
    if [[ "$BUILD_ONLY" == "1" ]]; then
        echo ""
        echo "═══════════════════════════════════════════════════════════════════"
        echo "  Windows 95 BUILD ONLY — staging build, nothing is deployed"
        echo "═══════════════════════════════════════════════════════════════════"
        echo ""
        if [[ -n "$DEPLOY_COMMIT" || -n "$DEPLOY_VERSION" ]]; then require_deploy_signature; fi
        build_staging
        log_info "Build-only complete. Staged tree: $STAGING_DIR"
        return 0
    fi

    if [[ "$PROD_DEPLOY" != "1" ]]; then
        if [[ "$FILES_ONLY" == "1" || "$SETUP_ONLY" == "1" ]]; then
            log_error "--files-only / --setup-only act on the PRODUCTION install and service."
            log_error "They require --prod (and W95_ALLOW_PROD=1). Nothing was done."
            exit 1
        fi
        require_deploy_signature
        echo ""
        echo "═══════════════════════════════════════════════════════════════════"
        echo "  Windows 95 DEV deploy — site only, production untouched"
        echo "═══════════════════════════════════════════════════════════════════"
        echo ""
        echo "  Target:  ${PI_ROOT:-$PI_TARGET}"
        echo "  Dev dir: $DEV_INSTALL_DIR/site  (served at ${DEV_URL})"
        echo "  Prod:    $INSTALL_DIR  (NOT written)"
        echo "  Service: $SERVICE_NAME  (NOT restarted)"
        echo ""
        build_staging
        deploy_dev_files
        echo ""
        echo -e "${GREEN}Dev deploy complete!${NC}"
        echo "  Dev:       ${DEV_URL}"
        echo "  Title bar: [DEV ${DEPLOY_SIG}]"
        echo ""
        return 0
    fi

    if [[ "${W95_ALLOW_PROD:-}" != "1" ]]; then
        log_error "--prod given but W95_ALLOW_PROD is not 1. Production deploy refused; nothing was done."
        log_error "Run:  W95_ALLOW_PROD=1 $0 --prod --commit <sha> --version <ver> [flags]"
        exit 1
    fi
    require_deploy_signature
    echo ""
    echo "═══════════════════════════════════════════════════════════════════"
    echo "  Windows 95 PRODUCTION Deployment"
    echo "═══════════════════════════════════════════════════════════════════"
    echo ""
    echo "  Target:  ${PI_ROOT:-$PI_TARGET}"
    echo "  Install: $INSTALL_DIR"
    echo "  Service: $SERVICE_NAME"
    echo ""
    if [[ "$DRY_RUN" == "1" ]]; then
        build_staging
        deploy_files
    elif [[ "$SETUP_ONLY" == "1" ]]; then
        setup_service
    elif [[ "$FILES_ONLY" == "1" ]]; then
        build_staging
        deploy_files
    else
        build_staging
        deploy_files
        setup_service
    fi
    echo ""
    echo -e "${GREEN}Deployment complete!${NC}"
    echo "  Site:    ${SITE_URL}"
    if [[ -n "$PI_ROOT" ]]; then echo "  Logs:    tail -f $INSTALL_DIR/win95.log"
    else echo "  Logs:    ssh -t $PI_TARGET 'journalctl -u $SERVICE_NAME -f'"; fi
    echo ""
}

main
