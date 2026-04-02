$ErrorActionPreference='Continue'
$artifact='dist/server.js'
if (-not (Test-Path $artifact)) {
  Write-Output "ARTIFACT_MISSING:$artifact"
  exit 1
}
$stdout=Join-Path $PWD 'api_smoke_stdout.log'
$stderr=Join-Path $PWD 'api_smoke_stderr.log'
Remove-Item $stdout,$stderr -ErrorAction SilentlyContinue
$proc=Start-Process -FilePath node -ArgumentList $artifact -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WorkingDirectory $PWD
Write-Output "STARTED_PID:$($proc.Id)"
$started=$false
for ($i=0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  $proc.Refresh()
  if ($proc.HasExited) { break }
  try {
    $null=Invoke-WebRequest -Uri 'http://127.0.0.1:3000/health' -UseBasicParsing -TimeoutSec 2
    $started=$true
    break
  } catch { }
}
$proc.Refresh()
if ($proc.HasExited) {
  Write-Output "STARTUP_FAILED:Process exited with code $($proc.ExitCode)"
  Write-Output 'STDERR_BEGIN'
  if (Test-Path $stderr) { Get-Content $stderr -Tail 200 }
  Write-Output 'STDERR_END'
  Write-Output 'STDOUT_BEGIN'
  if (Test-Path $stdout) { Get-Content $stdout -Tail 200 }
  Write-Output 'STDOUT_END'
  Write-Output 'PROBES_SKIPPED:true'
  exit 0
}
if ($started) { Write-Output 'STARTUP_CONFIRMED:true' } else { Write-Output 'STARTUP_UNCONFIRMED:true' }
$urls=@(
  'http://127.0.0.1:3000/health',
  'http://127.0.0.1:3000/ready',
  'http://127.0.0.1:3000/metrics',
  'http://127.0.0.1:3000/admin/system-health'
)
foreach ($u in $urls) {
  try {
    $resp=Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 5 -MaximumRedirection 0
    $body=$resp.Content
    if ($null -eq $body) { $body='' }
    $snippet=($body.Substring(0, [Math]::Min(200, $body.Length)) -replace "`r|`n", ' ')
    Write-Output "PROBE:$u STATUS:$([int]$resp.StatusCode) OK:true BODY:$snippet"
  } catch {
    $ex=$_.Exception
    $status=''
    $body=''
    if ($ex.Response) {
      try { $status=[int]$ex.Response.StatusCode } catch { $status='' }
      try {
        $stream=$ex.Response.GetResponseStream()
        if ($stream) {
          $reader=New-Object System.IO.StreamReader($stream)
          $body=$reader.ReadToEnd()
          $reader.Close()
        }
      } catch { }
    }
    $msg=($ex.Message -replace "`r|`n", ' ')
    $snippet=''
    if ($body) { $snippet=($body.Substring(0, [Math]::Min(200, $body.Length)) -replace "`r|`n", ' ') }
    Write-Output "PROBE:$u STATUS:$status OK:false ERROR:$msg BODY:$snippet"
  }
}
if (-not $proc.HasExited) {
  try {
    Stop-Process -Id $proc.Id
    Start-Sleep -Milliseconds 500
  } catch {
    Write-Output "STOP_ERROR:$($_.Exception.Message)"
  }
}
$proc.Refresh()
Write-Output "PROCESS_EXITED:$($proc.HasExited)"
if (-not $proc.HasExited) {
  try {
    $proc.Kill()
    Write-Output 'KILLED:true'
  } catch {
    Write-Output "KILL_ERROR:$($_.Exception.Message)"
  }
}
Write-Output 'STDERR_TAIL_BEGIN'
if (Test-Path $stderr) { Get-Content $stderr -Tail 80 }
Write-Output 'STDERR_TAIL_END'
