# Windows launcher for the edge node's paid agents (packages/cappz-edge-node/agents/server.ts).
# Copy it into <node folder>\agents\ (next to the node's run.ps1, node.env and sdk-<commit>\),
# with agents.env (mainnet) and agents-testnet.env made from the .example files.
#   run-agents.ps1                                            mainnet instance
#   run-agents.ps1 -EnvFile agents-testnet.env -Name testnet  testnet instance
# Start each from a Startup shortcut:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<node folder>\agents\run-agents.ps1" [-EnvFile … -Name …]
# Restarts the agents if they exit; one instance per -Name. Logs: data\agents[-<name>].log.
param([string]$EnvFile = 'agents.env', [string]$Name = '')
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = Split-Path $root -Parent
# Kept equal to the node's run.ps1 (the @cappz/sdk pin): the agents run from the same SDK snapshot.
$sdkCommit = '0000000000000000000000000000000000000000'
foreach ($f in "$node\node.env", "$root\$EnvFile") {
  foreach ($line in Get-Content $f) { if ($line -match '^\s*([A-Z_]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') } }
}
$sdk = "$node\sdk-$($sdkCommit.Substring(0, 12))"
$server = "$sdk\packages\cappz-edge-node\agents\server.ts"
$data = "$root\data"
New-Item -ItemType Directory -Force $data | Out-Null
$suffix = if ($Name) { "-$Name" } else { '' }
$log = "$data\agents$suffix.log"
if (-not (Test-Path $server)) { Add-Content $log "[run-agents$suffix] $(Get-Date -Format s) $server not found; not starting"; exit 1 }
# CAPPZ_AGENT_DATA from the env file must sit inside $data (the only folder the agents may write).
if (-not $env:CAPPZ_AGENT_DATA) { $env:CAPPZ_AGENT_DATA = if ($Name) { "$data\$Name" } else { $data } }
# 15.44.0: a wallet vouches for the node key. tools/declare-node-key.ts writes <node folder>\data\key-declarations.json
# (the node's own evidence file); when it exists the agents sign its hash into every record and refuse to sign without it.
$decl = "$node\data\key-declarations.json"; $revs = "$node\data\key-revocations.json"
if (-not $env:CAPPZ_NODE_KEY_DECLARATIONS -and (Test-Path $decl)) { $env:CAPPZ_NODE_KEY_DECLARATIONS = $decl }
$env:DENO_DIR = "$node\deno-cache"
$env:NO_COLOR = '1'
$mutex = New-Object System.Threading.Mutex($false, "Local\cappz-agents$suffix")
if (-not $mutex.WaitOne(0)) { exit 0 }
$deno = "$env:USERPROFILE\.deno\bin\deno.exe"
# --cached-only: no code downloads at run time (deno cache the server once after setup).
# Network: XRPL (payments) and the 127.0.0.1 listener. Reads the SDK, $data (its jobs and results) and the key declarations; writes only $data.
$denoArgs = "run --cached-only --config `"$sdk\deno.json`" --allow-net --allow-read=`"$sdk`",`"$data`",`"$decl`",`"$revs`" --allow-write=`"$data`" --allow-env `"$server`""
while ($true) {
  cmd /c "`"$deno`" $denoArgs >> `"$log`" 2>&1"
  Add-Content $log "[run-agents$suffix] $(Get-Date -Format s) agents exited ($LASTEXITCODE); restarting in 10 s"
  Start-Sleep 10
}
