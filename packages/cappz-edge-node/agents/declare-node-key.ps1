# Your payout wallet vouches for this node's signing key, so buyers can check who signed their receipts
# without trusting the website's certificate (KeyZ). Copy this file into <node folder>\agents\ next to run-agents.ps1.
#
#   Right-click > Run with PowerShell, or:
#   powershell -ExecutionPolicy Bypass -File "<node folder>\agents\declare-node-key.ps1"
#
# Default (15.45.0): ON THE LEDGER WITH XAMAN, no seed typed anywhere. A QR code opens; scan it in Xaman and
# approve. That signs one transaction from the payout account (it changes nothing on the account; fee ~0.00001 XRP).
# One-time setup for Xaman: create an app at https://apps.xumm.dev, then save its key and secret in
# <node folder>\agents\xaman.env as
#   CAPPZ_XAMAN_API_KEY=...
#   CAPPZ_XAMAN_API_SECRET=...
# (they can only ask you to sign; they cannot sign or move funds). Without them the transaction is printed
# for any wallet that signs a JSON transaction.
#
#   -Check          show the state of the declarations (no wallet needed)
#   -Revoke         withdraw it (e.g. if node.env may have leaked): another Xaman approval
#   -Days 1-90      how long it lasts (default 90; renew before it ends, the agents' log warns 14 days ahead)
#   -Network        mainnet (default) or testnet (to try it with test XRP; Xaman: Settings > Advanced > Developer mode)
#   -Hash <tx>      you already signed and submitted it elsewhere: register that transaction
#   -Account <r…>   another vouching account than CAPPZ_AGENT_PAYTO in agents.env
#   -Seed           the older way: type the account's family seed at a hidden prompt (signs off the ledger)
#   -Json           one JSON result line (for agents and scripts)
# The agents pick up a new declaration within a minute; restart them (or reboot) the first time.
param([switch]$Check, [switch]$Revoke, [int]$Days = 90, [string]$Network = 'mainnet', [string]$Hash = '', [string]$Account = '', [switch]$Seed, [switch]$Json)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = Split-Path $root -Parent
# The SDK snapshot the agents run (the $sdkCommit line of run-agents.ps1 beside this file).
$pin = (Select-String -Path "$root\run-agents.ps1" -Pattern "^\s*\`$sdkCommit\s*=\s*'([0-9a-f]{40})'" | Select-Object -First 1).Matches.Groups[1].Value
if (-not $pin) { Write-Error "No `$sdkCommit in $root\run-agents.ps1"; exit 1 }
$sdk = "$node\sdk-$($pin.Substring(0, 12))"
$tool = "$sdk\packages\cappz-edge-node\tools\declare-node-key.ts"
if (-not (Test-Path $tool)) { Write-Error "$tool not found: this needs SDK 15.45.0 or later (update `$sdkCommit in run-agents.ps1 and the node)"; exit 1 }
if (-not $Account) { $Account = (@(Get-Content "$root\agents.env") -match '^\s*CAPPZ_AGENT_PAYTO=' | Select-Object -First 1) -replace '^\s*CAPPZ_AGENT_PAYTO=', '' }
$env:DENO_DIR = "$node\deno-cache"
$deno = "$env:USERPROFILE\.deno\bin\deno.exe"
$data = "$node\data"
New-Item -ItemType Directory -Force $data | Out-Null
$toolArgs = @('run', '--config', "$sdk\deno.json", "--allow-read=$sdk,$node\node.env,$data,$root\xaman.env", "--allow-write=$data", '--allow-env', '--allow-net', '--allow-run=cmd',
  $tool, '--env', "$node\node.env", '--out', "$data\key-declarations.json")
if ($Json) { $toolArgs += '--json' }
if ($Check) { $toolArgs += '--check' }
elseif ($Seed) {
  if ($Revoke) { $toolArgs += '--revoke' } else { $toolArgs += @('--purposes', 'signing,hello', '--days', "$Days", '--expect', $Account) }
} else {
  $toolArgs += @('--ledger', '--account', $Account, '--network', $Network, '--xaman-env', "$root\xaman.env")
  if ($Revoke) { $toolArgs += '--revoke' } else { $toolArgs += @('--days', "$Days") }
  if ($Hash) { $toolArgs += @('--hash', $Hash) }
}
if (-not $Json) { Write-Host "Node folder: $node`nVouching account: $Account" }
& $deno @toolArgs
$code = $LASTEXITCODE
if (-not $Json -and $Host.Name -eq 'ConsoleHost' -and [Environment]::UserInteractive -and -not $Check) { Read-Host 'Press Enter to close' | Out-Null }
exit $code
