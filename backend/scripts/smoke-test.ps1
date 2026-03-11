```powershell
#!/usr/bin/env pwsh

param(
    [string] $BaseUrl     = "https://fieldtrack.meowsician.tech",
    [string] $EmployeeJwt = $env:EMPLOYEE_JWT,
    [string] $AdminJwt    = $env:ADMIN_JWT,
    [string] $LogFile     = ".\api-test-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

# ─────────────────────────────────────────────
# Retry wrapper
# ─────────────────────────────────────────────
function Invoke-WithRetry {
    param([scriptblock]$Action)

    $max = 3
    for ($i=1; $i -le $max; $i++) {
        try { return & $Action }
        catch {
            if ($i -eq $max) { throw }
            Start-Sleep -Seconds ([math]::Pow(2,$i))
        }
    }
}

# ─────────────────────────────────────────────
# Health wait
# ─────────────────────────────────────────────
function Wait-ForHealth {
    Write-Host "Waiting for API health..."

    for ($i=0; $i -lt 30; $i++) {
        try {
            $r = Invoke-WebRequest "$BaseUrl/health" -TimeoutSec 5
            if ($r.StatusCode -eq 200) {
                Write-Host "API is healthy"
                return
            }
        } catch {}

        Start-Sleep 1
    }

    throw "API never became healthy"
}

# ─────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────
$script:LogLines  = @()
$script:PassCount = 0
$script:FailCount = 0
$script:WarnCount = 0

function Log($msg,$lvl="INFO"){
    $line="[$(Get-Date -Format 'HH:mm:ss')] [$lvl] $msg"
    $script:LogLines += $line
}

function Pass($msg){
    $script:PassCount++
    Log $msg "PASS"
    Write-Host "✓ $msg" -ForegroundColor Green
}

function Fail($msg){
    $script:FailCount++
    Log $msg "FAIL"
    Write-Host "✗ $msg" -ForegroundColor Red
}

function Warn($msg){
    $script:WarnCount++
    Log $msg "WARN"
    Write-Host "⚠ $msg" -ForegroundColor Yellow
}

function Info($msg){
    Log $msg "INFO"
    Write-Host $msg
}

# ─────────────────────────────────────────────
# HTTP helper
# ─────────────────────────────────────────────
function Invoke-Api {

    param(
        [string]$Method,
        [string]$Path,
        [hashtable]$Headers=@{},
        $Body=$null,
        [int[]]$Expect=@(200),
        [string]$Label=""
    )

    $url="$BaseUrl$Path"

    $params=@{
        Uri=$url
        Method=$Method
        Headers=$Headers
        TimeoutSec=30
        ErrorAction="Stop"
    }

    if($Body){
        $params.Body=($Body|ConvertTo-Json -Compress)
        $params.ContentType="application/json"
    }

    $sw=[Diagnostics.Stopwatch]::StartNew()

    try{
        $resp = Invoke-WithRetry { Invoke-WebRequest @params }
        $status=[int]$resp.StatusCode
    }
    catch [System.Net.WebException]{
        $resp=$_.Exception.Response
        if(!$resp){
            Fail "$Method $Path — connection failure"
            return $null
        }
        $status=[int]$resp.StatusCode
    }

    $sw.Stop()

    if($Expect -contains $status){
        Pass "$Method $Path — $status ($($sw.ElapsedMilliseconds)ms)"
    }
    else{
        Fail "$Method $Path — $status expected $($Expect -join ',')"
    }

    try{
        return $resp.Content|ConvertFrom-Json
    }catch{
        return $null
    }
}

function AuthHeader($jwt){
    @{ Authorization="Bearer $jwt" }
}

function Mask($t){
    if(!$t){return "none"}
    return $t.Substring(0,8)+"...masked"
}

# ─────────────────────────────────────────────
# Startup
# ─────────────────────────────────────────────

Write-Host ""
Write-Host "FieldTrack 2.0 API Smoke Test"
Info "Base URL : $BaseUrl"
Info "Employee JWT : $(Mask $EmployeeJwt)"
Info "Admin JWT : $(Mask $AdminJwt)"

Wait-ForHealth

# ─────────────────────────────────────────────
# 1 Health
# ─────────────────────────────────────────────

Invoke-Api GET "/health"

Invoke-Api GET "/debug/redis" -Expect @(200,503)

# ─────────────────────────────────────────────
# 2 Auth guards
# ─────────────────────────────────────────────

@(
"/attendance/check-in"
"/attendance/check-out"
"/attendance/my-sessions"
"/attendance/org-sessions"
"/expenses"
"/expenses/my"
"/admin/expenses"
"/admin/org-summary"
"/admin/user-summary?userId=00000000-0000-0000-0000-000000000000"
"/admin/top-performers?metric=distance"
) | ForEach-Object {

Invoke-Api GET $_ -Expect @(401)

}

# ─────────────────────────────────────────────
# 3 Role guards
# ─────────────────────────────────────────────

if($EmployeeJwt){

@(
"/attendance/org-sessions"
"/admin/expenses"
"/admin/org-summary"
"/admin/top-performers?metric=distance"
) | ForEach-Object {

Invoke-Api GET $_ (AuthHeader $EmployeeJwt) -Expect @(403)

}

}

# ─────────────────────────────────────────────
# 4 Employee flow
# ─────────────────────────────────────────────

$sessionId=$null
$expenseId=$null
$userId=$null

if($EmployeeJwt){

$checkin = Invoke-Api POST "/attendance/check-in" (AuthHeader $EmployeeJwt)

if($checkin.data.id){
$sessionId=$checkin.data.id
}

if($sessionId){

Invoke-Api POST "/locations" (AuthHeader $EmployeeJwt) @{
session_id=$sessionId
latitude=51.5074
longitude=-0.1278
accuracy=10
recorded_at=(Get-Date).ToString("o")
}

Invoke-Api POST "/locations/batch" (AuthHeader $EmployeeJwt) @{
session_id=$sessionId
points=@(
@{latitude=51.5075;longitude=-0.1279;accuracy=9;recorded_at=(Get-Date).ToString("o")}
@{latitude=51.5076;longitude=-0.1280;accuracy=9;recorded_at=(Get-Date).ToString("o")}
)
}

Invoke-Api GET "/locations/my-route?sessionId=$sessionId" (AuthHeader $EmployeeJwt)

}

$exp = Invoke-Api POST "/expenses" (AuthHeader $EmployeeJwt) @{
amount=42.5
description="API test expense"
}

if($exp.data){
$expenseId=$exp.data.id
$userId=$exp.data.employee_id
}

Invoke-Api GET "/expenses/my" (AuthHeader $EmployeeJwt)

Invoke-Api GET "/attendance/my-sessions" (AuthHeader $EmployeeJwt)

Invoke-Api POST "/attendance/check-out" (AuthHeader $EmployeeJwt)

if($sessionId){
Invoke-Api POST "/attendance/$sessionId/recalculate" (AuthHeader $EmployeeJwt) -Expect @(200,202)
}

}

# ─────────────────────────────────────────────
# 5 Admin flow
# ─────────────────────────────────────────────

if($AdminJwt){

Invoke-Api GET "/attendance/org-sessions" (AuthHeader $AdminJwt)

$adminExp=Invoke-Api GET "/admin/expenses" (AuthHeader $AdminJwt)

if(!$expenseId -and $adminExp.data){
$pending=$adminExp.data|Where-Object{$_.status -eq "PENDING"}|Select-Object -First 1
if($pending){$expenseId=$pending.id}
}

if($expenseId){
Invoke-Api PATCH "/admin/expenses/$expenseId" (AuthHeader $AdminJwt) @{
status="APPROVED"
}
}

Invoke-Api GET "/admin/org-summary" (AuthHeader $AdminJwt)

if($userId){
Invoke-Api GET "/admin/user-summary?userId=$userId" (AuthHeader $AdminJwt)
}

foreach($metric in @("distance","duration","sessions")){
Invoke-Api GET "/admin/top-performers?metric=$metric" (AuthHeader $AdminJwt)
}

}

# ─────────────────────────────────────────────
# 6 Validation tests
# ─────────────────────────────────────────────

if($EmployeeJwt){

Invoke-Api POST "/expenses" (AuthHeader $EmployeeJwt) @{
amount=-5
description="x"
} -Expect @(400,422)

Invoke-Api POST "/expenses" (AuthHeader $EmployeeJwt) @{
description="missing amount"
} -Expect @(400,422)

Invoke-Api POST "/locations" (AuthHeader $EmployeeJwt) @{
session_id="not-a-uuid"
latitude=999
longitude=0
accuracy=5
recorded_at=(Get-Date).ToString("o")
} -Expect @(400,422)

Invoke-Api GET "/admin/top-performers?metric=invalid" (AuthHeader $EmployeeJwt) -Expect @(400,403,422)

}

# ─────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────

$total=$script:PassCount+$script:FailCount

Write-Host ""
Write-Host "Passed : $($script:PassCount)"
Write-Host "Failed : $($script:FailCount)"
Write-Host "Warnings : $($script:WarnCount)"

$script:LogLines | Set-Content $LogFile

$report=@{
passed=$script:PassCount
failed=$script:FailCount
warnings=$script:WarnCount
logs=$script:LogLines
}

$report | ConvertTo-Json -Depth 6 | Set-Content "smoke-report.json"

if($script:FailCount -gt 0){
exit 1
}
else{
exit 0
}
```
