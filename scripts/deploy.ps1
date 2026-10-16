# Local deployment orchestrator for Windows.
#
#   pwsh scripts/deploy.ps1 -Server root@1.2.3.4
#   pwsh scripts/deploy.ps1 -Server root@1.2.3.4 -Smoke
#   pwsh scripts/deploy.ps1 -Server deploy@1.2.3.4 -NoSync
#   pwsh scripts/deploy.ps1 -Server deploy@1.2.3.4 -CheckEnv
#
# What it does:
#   1. Preflight: ssh/scp/tar present, remote host reachable, Docker installed
#   2. Pack the project (excluding node_modules/.next/var/.env) and upload it
#   3. Run scripts/deploy.sh on the server (build -> migrate -> restart -> health)
#   4. Optionally run the end-to-end smoke test on the server
#   5. Propagate the remote exit code, so this can be used from CI
#
# WHY THIS FILE IS ASCII-ONLY
#   Windows PowerShell 5.1 reads .ps1 files without a UTF-8 BOM using the
#   system ANSI code page. On this machine that is 936 (GBK), so any non-ASCII
#   literal written as UTF-8 would be decoded as garbage and printed as mojibake.
#   All human-facing prose therefore lives in docs/ (UTF-8 markdown, read by
#   editors and browsers, which handle UTF-8 correctly). Keep it that way.
#
# WHY tar + scp INSTEAD OF rsync
#   Windows ships no rsync, but tar and scp have been built in since 10 1803.
#   The project is ~1 MB without dependencies, so a full transfer takes a
#   second or two - not worth adding a dependency to save.
#
# WHY node_modules IS EXCLUDED
#   It is platform-specific (@node-rs/argon2 and pg carry native binaries).
#   Copying it from Windows to Linux produces confusing runtime failures.
#   The server installs its own copies during `docker compose build`.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Server,

    [string]$RemotePath = '/opt/bbs',

    # End-to-end smoke test after deploy
    [switch]$Smoke,

    # Skip code sync; only run the server-side deploy (e.g. you already git pulled)
    [switch]$NoSync,

    # Upload dist/bbs-images.tar.gz and `docker load` it, then deploy with --no-build.
    # Use this on low-memory servers: they never run `docker build`, so the
    # kernel never swaps hard enough to make sshd unreachable.
    [switch]$Images,

    # Only probe connectivity and environment; change nothing
    [switch]$CheckEnv
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Write-Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  [ok] $text" -ForegroundColor Green }
function Write-Note($text) { Write-Host "  [!!] $text" -ForegroundColor Yellow }
function Fail($text) {
    Write-Host ""
    Write-Host "  [FAIL] $text" -ForegroundColor Red
    exit 1
}

# --- 0. Local tooling -------------------------------------------------------
Write-Step 'Local preflight'

foreach ($tool in @('ssh', 'scp', 'tar')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Fail "$tool not found. Windows 10 1803+ ships OpenSSH and tar; otherwise install and add to PATH."
    }
}
if (-not (Test-Path (Join-Path $ProjectRoot 'docker-compose.yml'))) {
    Fail "docker-compose.yml not found under inferred project root: $ProjectRoot"
}
Write-Ok 'ssh / scp / tar available'

# --- 1. Remote probe --------------------------------------------------------
Write-Step "Probing $Server"

# Single-quoted here-string: nothing is interpolated locally, so the remote
# shell sees the script verbatim. The path placeholder is substituted after.
$probeTemplate = @'
set -e
echo "USER=$(id -un)"
echo "OS=$(. /etc/os-release 2>/dev/null && echo $PRETTY_NAME || echo unknown)"
echo "CPU=$(nproc)"
echo "MEM_MB=$(free -m | awk '/^Mem:/{print $2}')"
echo "SWAP_MB=$(free -m | awk '/^Swap:/{print $2}')"
echo "DISK_FREE=$(df -h / | awk 'NR==2{print $4}')"
echo "FD_LIMIT=$(ulimit -n)"
if command -v docker >/dev/null 2>&1; then
  echo "DOCKER=$(docker --version | cut -d, -f1)"
  if docker compose version >/dev/null 2>&1; then echo "COMPOSE=v2"; else echo "COMPOSE=none"; fi
else
  echo "DOCKER=missing"
  echo "COMPOSE=none"
fi
if [ -f __REMOTE_PATH__/.env ]; then echo "ENV=present"; else echo "ENV=missing"; fi
if command -v node >/dev/null 2>&1; then echo "NODE=$(node -v)"; else echo "NODE=missing"; fi
'@
$probe = $probeTemplate -replace '__REMOTE_PATH__', $RemotePath

$info = & ssh -o ConnectTimeout=10 -o BatchMode=yes $Server $probe 2>&1
if ($LASTEXITCODE -ne 0) {
    $info | ForEach-Object { Write-Host $_ }
    Fail @"
Cannot SSH into $Server. Check:
    - host address and port (for non-22 use an ssh config alias)
    - public key installed (BatchMode=yes never prompts for a password)
    - cloud security group allows SSH
"@
}

$facts = @{}
foreach ($line in $info) {
    if ("$line" -match '^([A-Z_]+)=(.*)$') { $facts[$Matches[1]] = $Matches[2] }
}

Write-Ok "connected as $($facts['USER'])"
Write-Host "       os        $($facts['OS'])"
Write-Host "       cpu       $($facts['CPU']) core(s)"
Write-Host "       memory    $($facts['MEM_MB']) MB   swap $($facts['SWAP_MB']) MB"
Write-Host "       disk free $($facts['DISK_FREE'])"
Write-Host "       fd limit  $($facts['FD_LIMIT'])"
Write-Host "       docker    $($facts['DOCKER'])   compose $($facts['COMPOSE'])"
Write-Host "       node      $($facts['NODE'])"
Write-Host "       .env      $($facts['ENV'])"

# --- health warnings --------------------------------------------------------
$warnings = @()
if ($facts['DOCKER'] -eq 'missing' -or $facts['COMPOSE'] -eq 'none') {
    $warnings += 'Docker or Compose missing -> run scripts/provision.sh first'
}
$memMb = 0; [void][int]::TryParse($facts['MEM_MB'], [ref]$memMb)
$swapMb = 0; [void][int]::TryParse($facts['SWAP_MB'], [ref]$swapMb)
if ($memMb -lt 3000 -and $swapMb -lt 1500) {
    $warnings += "only $memMb MB RAM and <1.5 GB swap -> docker build may OOM; add swap first"
}
$fdLimit = 0; [void][int]::TryParse($facts['FD_LIMIT'], [ref]$fdLimit)
if ($facts['FD_LIMIT'] -ne 'unlimited' -and $fdLimit -lt 10000) {
    $warnings += "fd limit is $($facts['FD_LIMIT']) -> SSE starts failing around 300-400 connections"
}
if ($facts['NODE'] -eq 'missing') {
    $warnings += 'Node not installed -> the smoke test cannot run on the server'
}
if ($facts['ENV'] -eq 'missing') {
    $warnings += ".env missing at $RemotePath -> create it before the first deploy (docs/DEPLOY.md section 3)"
}
if ($warnings.Count -gt 0) {
    Write-Host ""
    foreach ($w in $warnings) { Write-Note $w }
}

if ($CheckEnv) {
    Write-Host ""
    Write-Host "Probe complete (-CheckEnv made no changes)." -ForegroundColor Green
    exit 0
}

# --- 2. First-deploy guidance ----------------------------------------------
if ($facts['ENV'] -eq 'missing') {
    Write-Host ""
    Write-Host "First deploy: create $RemotePath/.env before continuing." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "    # generate a session secret"
    Write-Host "    ssh $Server `"openssl rand -base64 48`""
    Write-Host ""
    Write-Host "    # create the file (full template in docs/DEPLOY.md section 3)"
    Write-Host "    ssh -t $Server `"vi $RemotePath/.env`""
    Write-Host ""
    Write-Host "    # ensure the directory exists and is owned by your user"
    Write-Host "    ssh $Server 'sudo mkdir -p $RemotePath'"
    Write-Host "    ssh $Server 'sudo chown `$(id -un):`$(id -gn) $RemotePath'"
    Write-Host ""
    Write-Host "    # then re-run this script"
    Write-Host "    pwsh scripts/deploy.ps1 -Server $Server"
    Write-Host ""
    Fail '.env is missing; aborted so we do not deploy a site that cannot reach its database'
}

# --- 3. Sync code -----------------------------------------------------------
if (-not $NoSync) {
    Write-Step 'Packing and uploading'

    $exclude = @(
        '--exclude=node_modules', '--exclude=.next', '--exclude=var',
        '--exclude=backups', '--exclude=.git', '--exclude=data',
        '--exclude=.env', '--exclude=.ssh-local', '--exclude=*.log',
        '--exclude=tsconfig.tsbuildinfo', '--exclude=.DS_Store',
        # dist/ holds the image archive, which -Images uploads separately.
        # Without this it would be transferred twice (and land in the build
        # context on the server, bloating every subsequent docker build).
        '--exclude=dist'
    )

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $tarball = Join-Path $env:TEMP "bbs-$stamp.tar.gz"
    $remoteTar = "/tmp/bbs-$stamp.tar.gz"

    Push-Location $ProjectRoot
    try {
        # Archive the WHOLE project with exclusions, rather than an explicit file list.
        #
        # An explicit list caused real bugs: every time a new script was added
        # (promote.mjs, verify-attachments.mjs) it was silently missing from the
        # uploaded tree, and therefore missing from the image built on the server
        # (`COPY . .` only sees what tar delivered). The symptom was a confusing
        # MODULE_NOT_FOUND from inside the container.
        #
        # Excluding by pattern is fail-safe: new files are included by default.
        # -C pins the root so Windows drive letters and spaces never enter the archive.
        & tar -czf $tarball @exclude -C $ProjectRoot .
        if ($LASTEXITCODE -ne 0) { Fail 'tar failed' }
    } finally {
        Pop-Location
    }

    $sizeMB = [math]::Round((Get-Item $tarball).Length / 1MB, 2)
    Write-Ok "packed $sizeMB MB (node_modules / .next / .env excluded)"

    & scp -q $tarball "${Server}:$remoteTar"
    if ($LASTEXITCODE -ne 0) { Fail 'scp upload failed' }
    Write-Ok 'uploaded'

    # Extract over the existing tree. The remote .env is untouched because we
    # never packed it.
    $extract = "mkdir -p $RemotePath && tar -xzf $remoteTar -C $RemotePath && rm -f $remoteTar && echo EXTRACT_OK"
    $result = & ssh $Server $extract 2>&1
    $resultText = ($result | Out-String)
    if ($LASTEXITCODE -ne 0 -or $resultText -notmatch 'EXTRACT_OK') {
        Write-Host $resultText
        Fail "remote extract failed (is $RemotePath writable by this user?)"
    }
    Write-Ok "extracted into $RemotePath"

    Remove-Item $tarball -Force -ErrorAction SilentlyContinue
} else {
    Write-Step 'Packing and uploading'
    Write-Ok 'skipped (-NoSync)'
}

# --- 4. Upload prebuilt images (optional) -----------------------------------
# On a low-memory server this is the whole point: `docker build` there peaks at
# ~1.8 GB and can drive the machine into swap thrashing so severe that sshd
# cannot complete a banner exchange (observed; needed a console reboot).
# `docker load` is a straightforward disk write with negligible memory cost.
if ($Images) {
    Write-Step 'Uploading prebuilt images'

    $archive = Join-Path $ProjectRoot 'dist\bbs-images.tar.gz'
    if (-not (Test-Path $archive)) {
        Fail @"
dist\bbs-images.tar.gz not found.

Build it first (in WSL, not Windows):

    wsl -d Ubuntu -u root -- bash "/mnt/e/dsh project bbs/scripts/build-image.sh"

Or via npm:  npm run build:image
"@
    }

    $archiveMB = [math]::Round((Get-Item $archive).Length / 1MB, 1)
    Write-Ok "archive: $archiveMB MB"

    $remoteArchive = '/tmp/bbs-images.tar.gz'
    & scp -q $archive "${Server}:$remoteArchive"
    if ($LASTEXITCODE -ne 0) { Fail 'scp of image archive failed' }
    Write-Ok 'uploaded'

    Write-Host '       loading images on the server (may take a minute)' -ForegroundColor DarkGray
    $loadCmd = "docker load -i $remoteArchive && rm -f $remoteArchive && echo LOAD_OK"
    $loadOut = & ssh $Server $loadCmd 2>&1
    $loadText = ($loadOut | Out-String)
    if ($LASTEXITCODE -ne 0 -or $loadText -notmatch 'LOAD_OK') {
        Write-Host $loadText
        Fail 'docker load failed on the server'
    }
    # docker load prints "Loaded image: <tag>" lines; surface them so the
    # operator can confirm the expected tags actually arrived
    foreach ($line in $loadOut) {
        if ("$line" -match 'Loaded image') { Write-Host "       $line" -ForegroundColor DarkGray }
    }
    Write-Ok 'images loaded'

    # Loading images means the server must NOT rebuild
    $NoBuild = $true
} else {
    $NoBuild = $false
}

# --- 5. Server-side deploy --------------------------------------------------
Write-Step 'Running server-side deploy'
if ($NoBuild) {
    Write-Host '       migrate -> restart -> health check (build skipped)' -ForegroundColor DarkGray
} else {
    Write-Host '       build -> migrate -> restart -> health check (may take minutes)' -ForegroundColor DarkGray
}

$deployArgs = @()
if ($NoSync)  { $deployArgs += '--no-pull' }
if ($NoBuild) { $deployArgs += '--no-build' }
if ($Smoke)   { $deployArgs += '--smoke' }

$remoteCmd = "cd $RemotePath && bash scripts/deploy.sh $($deployArgs -join ' ')"
& ssh -t $Server $remoteCmd
$deployExit = $LASTEXITCODE

if ($deployExit -ne 0) {
    Write-Host ""
    Fail "server-side deploy failed (exit $deployExit). Inspect logs with:  ssh $Server 'cd $RemotePath && docker compose logs --tail 80 app'"
}

# --- 6. Done ----------------------------------------------------------------
Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "  Local orchestration complete" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  tail logs     ssh -t $Server 'cd $RemotePath && docker compose logs -f app'"
Write-Host "  local preview ssh -N -L 3000:127.0.0.1:3000 $Server"
Write-Host "  smoke test    ssh $Server 'cd $RemotePath && npm run smoke'"
Write-Host ""

exit 0
