$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskStatePath = Join-Path $taskRoot '.publish/free-demo-publication.json'
$taskFiles = @(
  @{ path = 'index.html'; local = (Join-Path $taskRoot 'Tradesuite Demo.html'); contentType = 'text/html; charset=utf-8' },
  @{ path = 'licenses/DM-Sans-LICENSE.txt'; local = (Join-Path $taskRoot 'public/fonts/DM-Sans-LICENSE.txt'); contentType = 'text/plain; charset=utf-8' },
  @{ path = 'licenses/Manrope-LICENSE.txt'; local = (Join-Path $taskRoot 'public/fonts/Manrope-LICENSE.txt'); contentType = 'text/plain; charset=utf-8' }
)
$null = New-Item -ItemType Directory -Force -Path (Join-Path $taskRoot '.publish')
$taskHeaders = @{ 'X-HereNow-Client' = 'codex/direct-api' }
$taskManifest = foreach ($taskFile in $taskFiles) {
  @{ path = $taskFile.path; size = (Get-Item -LiteralPath $taskFile.local).Length; contentType = $taskFile.contentType; hash = (Get-FileHash -LiteralPath $taskFile.local -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$taskPayload = @{ files = @($taskManifest); displayName = 'Tradesuite demo'; displayDescription = 'Sample-only interactive trades business dashboard. Texts and emails are simulated; changes stay in the browser.' }
if (Test-Path -LiteralPath $taskStatePath) {
  $taskPrevious = Get-Content -LiteralPath $taskStatePath -Raw | ConvertFrom-Json
  $taskPayload.claimToken = $taskPrevious.claimToken
  $taskPublish = Invoke-RestMethod -Uri ('https://here.now/api/v1/publish/' + [Uri]::EscapeDataString($taskPrevious.slug)) -Method Put -Headers $taskHeaders -ContentType 'application/json' -Body ($taskPayload | ConvertTo-Json -Depth 6) -TimeoutSec 30
  $taskPublish | Add-Member -NotePropertyName claimToken -NotePropertyValue $taskPrevious.claimToken -Force
  $taskPublish | Add-Member -NotePropertyName claimUrl -NotePropertyValue $taskPrevious.claimUrl -Force
} else {
  $taskBody = $taskPayload | ConvertTo-Json -Depth 6
  $taskPublish = Invoke-RestMethod -Uri 'https://here.now/api/v1/publish' -Method Post -Headers $taskHeaders -ContentType 'application/json' -Body $taskBody -TimeoutSec 30
}
$taskPublish | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath $taskStatePath -Encoding utf8
foreach ($taskUpload in $taskPublish.upload.uploads) {
  $taskFile = $taskFiles | Where-Object path -eq $taskUpload.path | Select-Object -First 1
  if (-not $taskFile) { throw 'Unexpected upload file requested.' }
  $taskUploadUri = [Uri]$taskUpload.url
  if ($taskUploadUri.Scheme -ne 'https' -or -not $taskUploadUri.Host.EndsWith('.r2.cloudflarestorage.com')) { throw 'Unexpected upload storage host.' }
  $null = Invoke-WebRequest -UseBasicParsing -Uri $taskUploadUri -Method Put -ContentType $taskFile.contentType -InFile $taskFile.local -TimeoutSec 60
}
$taskFinalizeUri = [Uri]$taskPublish.upload.finalizeUrl
if ($taskFinalizeUri.Scheme -ne 'https' -or $taskFinalizeUri.Host -ne 'here.now') { throw 'Unexpected finalize host.' }
$taskFinal = Invoke-RestMethod -Uri $taskFinalizeUri -Method Post -Headers $taskHeaders -ContentType 'application/json' -Body (@{versionId=$taskPublish.upload.versionId} | ConvertTo-Json) -TimeoutSec 30
if (-not $taskFinal.success -or $taskFinal.publishStatus.state -ne 'live') { throw 'The host did not confirm a live deployment.' }
$taskSiteUri = [Uri]$taskFinal.siteUrl
if ($taskSiteUri.Scheme -ne 'https' -or -not $taskSiteUri.Host.EndsWith('.here.now')) { throw 'Unexpected site host.' }
$taskCheck = Invoke-WebRequest -UseBasicParsing -Uri $taskSiteUri -TimeoutSec 30
if ($taskCheck.StatusCode -ne 200 -or $taskCheck.Content -notmatch 'Browser demo') { throw 'Public page verification did not pass.' }
$taskReceipt = [ordered]@{ siteUrl=$taskFinal.siteUrl; claimUrl=$taskPublish.claimUrl; expiresAt=$taskFinal.publishStatus.expiresAt; state=$taskFinal.publishStatus.state; verifiedHttpStatus=$taskCheck.StatusCode; verifiedAt=(Get-Date).ToUniversalTime().ToString('o') }
$taskReceipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRoot '.publish/free-demo-receipt.json') -Encoding utf8
Write-Output ('Live demo: ' + $taskReceipt.siteUrl)
Write-Output 'The private ownership link is saved in .publish/free-demo-receipt.json. Do not share or commit that file.'
