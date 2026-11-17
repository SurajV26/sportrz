$ErrorActionPreference = 'Stop'

$projectRoot = (Get-Location).Path
$targetFiles = @(
    'src/lib/affiliate-links.ts',
    'src/app/r/[code]/route.ts'
)

$oldLine = 'const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();'
$newLine = 'const configured = process.env.APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();'

foreach ($relativePath in $targetFiles) {
    $fullPath = Join-Path $projectRoot $relativePath

    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Required source file not found: $relativePath. Run this script from the Sportrz project root."
    }

    $content = [System.IO.File]::ReadAllText($fullPath)

    if ($content.Contains($newLine)) {
        Write-Host "Already patched: $relativePath" -ForegroundColor Yellow
        continue
    }

    if (-not $content.Contains($oldLine)) {
        throw "Expected configuration line not found in $relativePath. No further files were changed. Please share this file for a precise patch."
    }

    $backupPath = "$fullPath.bak-before-referral-origin-fix"
    if (-not (Test-Path -LiteralPath $backupPath)) {
        Copy-Item -LiteralPath $fullPath -Destination $backupPath
    }

    $updated = $content.Replace($oldLine, $newLine)
    [System.IO.File]::WriteAllText($fullPath, $updated, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Patched: $relativePath" -ForegroundColor Green
    Write-Host "Backup:  $backupPath" -ForegroundColor DarkGray
}

# Ensure the production build uses the public domain while preserving other env entries.
$envPath = Join-Path $projectRoot '.env.production.local'
$envLines = @()
if (Test-Path -LiteralPath $envPath) {
    $envLines = @(Get-Content -LiteralPath $envPath)
}

$productionValues = @{
    'APP_URL' = 'https://sportrz.com'
    'NEXT_PUBLIC_APP_URL' = 'https://sportrz.com'
}

foreach ($entry in $productionValues.GetEnumerator()) {
    $pattern = '^' + [regex]::Escape($entry.Key) + '=' 
    $found = $false
    for ($i = 0; $i -lt $envLines.Count; $i++) {
        if ($envLines[$i] -match $pattern) {
            $envLines[$i] = "$($entry.Key)=$($entry.Value)"
            $found = $true
        }
    }
    if (-not $found) {
        $envLines += "$($entry.Key)=$($entry.Value)"
    }
}

[System.IO.File]::WriteAllLines($envPath, $envLines, [System.Text.UTF8Encoding]::new($false))
Write-Host "Production URL settings written: .env.production.local" -ForegroundColor Green

Write-Host "`nReferral origin fix applied. Next run: npm run build" -ForegroundColor Cyan
