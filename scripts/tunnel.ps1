# SSH tunnel to the server's Caddy, so you can browse the deployed site locally
# without a domain, DNS, or certificates.
#
#   powershell -ExecutionPolicy Bypass -File scripts/tunnel.ps1 -Server admin@1.2.3.4
#   powershell -ExecutionPolicy Bypass -File scripts/tunnel.ps1 -Server admin@1.2.3.4 -Port 9090
#
# Then open:  http://localhost:8080
#
# WHY PORT 8080 AND NOT 80
#   Binding port 80 locally needs Administrator rights on Windows, and would
#   also collide with any local web server. 8080 needs neither.
#
# WHY THIS WORKS AT ALL
#   The app container only exposes 3000 on the compose network (it is not
#   published to the host on purpose - that is the security boundary).
#   Caddy listens on the host's 80/443, so we forward to Caddy and let it
#   proxy to the app. This also means the tunnel exercises the real Caddy
#   config, including the SSE-relevant `flush_interval -1`, instead of
#   bypassing it.
#
# ASCII-only on purpose: Windows PowerShell 5.1 decodes .ps1 files without a
# UTF-8 BOM using the system ANSI code page (936/GBK on a Chinese system),
# so non-ASCII literals would print as mojibake. Prose lives in docs/.
#
# WHY IT RECONNECTS BY DEFAULT
#   A long-lived SSH tunnel WILL be killed by something eventually: home router
#   NAT timeouts, ISP path changes, the server's sshd recycling sessions. The
#   failure is silent from the browser's point of view - the tab just stops
#   loading - and the error looks like "the site is down" rather than "the
#   tunnel died". Observed in practice: a tunnel that had been up for 30+ hours
#   dropped with `client_loop: send disconnect: Connection aborted`.
#
#   So the tunnel is wrapped in a retry loop. Browsers retry on their own, which
#   means the page recovers a few seconds after the link comes back, with no
#   action from you. Use -NoRetry if you want the old behaviour (e.g. when
#   running under a supervisor that already handles restarts).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Server,

    # Local port to listen on
    [int]$Port = 8080,

    # Set when your server serves plain HTTP (SITE_ADDRESS=:80).
    # Omit it if the server has TLS enabled.
    [switch]$PlainHttp,

    [string]$IdentityFile = '',

    # Do not reconnect after the connection drops; just exit
    [switch]$NoRetry
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Host "ssh not found. Windows 10 1803+ ships OpenSSH; otherwise install it." -ForegroundColor Red
    exit 1
}

$sshArgs = @('-N')
if ($IdentityFile) { $sshArgs += @('-i', $IdentityFile) }
$sshArgs += @('-o', 'ExitOnForwardFailure=yes')
# Detected in ~45s (15s x 3) instead of the 90s you get from the 30s default.
# A half-open TCP connection keeps the local port bound, so a slow detection
# means the browser hangs on a dead tunnel for up to a minute and a half.
$sshArgs += @('-o', 'ServerAliveInterval=15')
$sshArgs += @('-o', 'ServerAliveCountMax=3')
$sshArgs += @('-L', "${Port}:127.0.0.1:80")
$sshArgs += $Server

Write-Host ""
Write-Host "SSH tunnel starting" -ForegroundColor Cyan
Write-Host "  server      $Server"
Write-Host "  local port  $Port  ->  server 127.0.0.1:80 (Caddy)"
if ($NoRetry) {
    Write-Host "  reconnect   disabled (-NoRetry)" -ForegroundColor DarkGray
} else {
    Write-Host "  reconnect   automatic (Ctrl+C to stop)" -ForegroundColor DarkGray
}
Write-Host ""
Write-Host "  Open in browser:  http://localhost:$Port" -ForegroundColor Green
Write-Host ""
Write-Host "  Keep this window open. Press Ctrl+C to stop." -ForegroundColor DarkGray
if ($PlainHttp) {
    Write-Host "  (plain HTTP mode expected - server SITE_ADDRESS=:80)" -ForegroundColor DarkGray
} else {
    Write-Host "  Note: if the server has TLS enabled, Caddy will answer with a" -ForegroundColor DarkGray
    Write-Host "  redirect to https://localhost - set SITE_ADDRESS=:80 on the" -ForegroundColor DarkGray
    Write-Host "  server, or use -PlainHttp, to avoid certificate warnings." -ForegroundColor DarkGray
}
Write-Host ""

if ($NoRetry) {
    & ssh @sshArgs
    exit $LASTEXITCODE
}

$attempt = 0
# -WindowStyle is not available here; the loop runs until Ctrl+C or the user
# closes the window. Each iteration is one connection attempt.
while ($true) {
    $attempt++
    if ($attempt -gt 1) {
        Write-Host ("[{0}] reconnecting (attempt {1}) ..." -f (Get-Date -Format 'HH:mm:ss'), $attempt) -ForegroundColor Yellow
    }

    & ssh @sshArgs
    $code = $LASTEXITCODE

    # Ctrl+C surfaces as a non-zero exit too, so we cannot tell "user stopped"
    # from "connection dropped". Sleeping briefly and retrying is the safer
    # default: if the user really wants to stop, the window is theirs to close.
    Write-Host ("[{0}] tunnel dropped (exit {1}) - retrying in 5s" -f (Get-Date -Format 'HH:mm:ss'), $code) -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}
