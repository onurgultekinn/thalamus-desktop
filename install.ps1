<#
.SYNOPSIS
    Thalamus Desktop — tek satır kurulum.

.DESCRIPTION
    Bu script, GitHub Releases'teki en son sürümü indirir, SHA256 özetini
    doğrular ve sessizce kurar.

    Neden bu yol var: tarayıcıdan indirilen .exe dosyasına Windows
    "Mark-of-the-Web" etiketi basar ve SmartScreen "Windows korumalı sizin
    bilgisayarınız" uyarısı çıkarır. Bu script dosyayı Invoke-WebRequest ile
    indirdiği için etiket yapışmaz, uyarı çıkmaz; ayrıca diskte .ps1 dosyası
    olmadığından ExecutionPolicy engeline de takılmaz.

    Bunun karşılığında güvence SHA256 doğrulamasıdır: script, indirdiği
    dosyanın özetini sürümün SHA256SUMS.txt dosyasıyla karşılaştırır ve
    tutmuyorsa kurmaz.

.EXAMPLE
    irm https://raw.githubusercontent.com/onurgultekinn/thalamus-desktop/master/install.ps1 | iex

.EXAMPLE
    # Belirli bir sürümü kur
    $env:THALAMUS_VERSION = "v0.1.0"
    irm https://raw.githubusercontent.com/onurgultekinn/thalamus-desktop/master/install.ps1 | iex
#>

# Konsol kodlamasi: Windows PowerShell 5.1 varsayilan olarak UTF-8 basmaz,
# Turkce karakterler bozulur. Script basinda UTF-8'e aliyoruz.
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Repo = 'onurgultekinn/thalamus-desktop'
$AppName = 'Thalamus'

function Write-Step([string]$Message) {
    Write-Host "  $Message" -ForegroundColor Cyan
}
function Write-OK([string]$Message) {
    Write-Host "[OK] $Message" -ForegroundColor Green
}
function Write-Warn([string]$Message) {
    Write-Host "[!] $Message" -ForegroundColor Yellow
}
function Fail([string]$Message, [string]$Hint) {
    Write-Host "[HATA] $Message" -ForegroundColor Red
    if ($Hint) { Write-Host "  $Hint" -ForegroundColor DarkGray }
    throw "Thalamus kurulumu durduruldu."
}

# ── Ortam kontrolü ────────────────────────────────────────────────────────
# Tüm gövde tek bir try/catch içinde: `irm | iex` ile çalışırken yakalanan hata
# yeniden fırlatılmadığı için kullanıcı çirkin bir stack trace görmez; Fail()
# mesajı nedeni zaten yazdırmış olur. exit KULLANILMAZ — iex içinde çağrılırsa
# kullanıcının PowerShell penceresini kapatır.
try {
if ($PSVersionTable.PSVersion.Major -lt 5) {
    Fail "PowerShell 5.0 veya üzeri gerekiyor (bulunan: $($PSVersionTable.PSVersion))."
}
# Windows PowerShell 5.1'de TLS 1.2 varsayılan değil; GitHub API reddeder.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { /* PowerShell 7+ zaten TLS 1.2+ kullanır */ }

if (-not [Environment]::Is64BitOperatingSystem) {
    Fail "Thalamus yalnızca 64-bit Windows'ta çalışır." "Windows 10/11 x64 gerekir."
}

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne 'AMD64' -and $arch -ne 'ARM64') {
    Write-Warn "Beklenmeyen mimari: $arch — kurulum yine denenecek."
}

Write-Host ""
Write-Host "  $AppName Desktop — kurulum" -ForegroundColor White
Write-Host ""

# ── Sürümü çöz ────────────────────────────────────────────────────────────
$Version = $env:THALAMUS_VERSION
if ([string]::IsNullOrWhiteSpace($Version)) {
    Write-Step "En son sürüm sorgulanıyor…"
    try {
        $headers = @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'thalamus-installer' }
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers -UseBasicParsing
        $Version = $release.tag_name
    } catch {
        Fail "Sürüm bilgisi alınamadı." @"
Bu genellikle iki nedenden biridir:
  1. Henüz yayınlanmış bir sürüm yok.
  2. Ağ/GitHub erişimi engelli.
Sürüm sayfası: https://github.com/$Repo/releases
"@
    }
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    Fail "Sürüm bulunamadı." "https://github.com/$Repo/releases adresini kontrol edin."
}
Write-OK "Sürüm: $Version"

# ── Kurulum dosyasını bul ─────────────────────────────────────────────────
$downloadBase = "https://github.com/$Repo/releases/download/$Version"
$tmp = Join-Path $env:TEMP ("thalamus-install-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
    # NSIS (.exe) tercih edilir: sessiz kurulum bayrağı (/S) en geniş uyumlu.
    # MSI'ye yalnız NSIS bulunamazsa düşülür.
    $fileName = $null
    $installerKind = $null

    Write-Step "Sürüm varlıkları listeleniyor…"
    try {
        $headers = @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'thalamus-installer' }
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Version" -Headers $headers -UseBasicParsing
        $assets = @($rel.assets)
    } catch {
        $assets = @()
    }

    $nsis = $assets | Where-Object { $_.name -match '(?i)-setup\.exe$' } | Select-Object -First 1
    $msi  = $assets | Where-Object { $_.name -match '(?i)\.msi$' }       | Select-Object -First 1

    if ($nsis) { $fileName = $nsis.name; $installerKind = 'nsis' }
    elseif ($msi) { $fileName = $msi.name; $installerKind = 'msi' }
    else {
        Fail "$Version sürümünde kurulum dosyası bulunamadı." @"
Sürüm sayfasından elle indirebilirsiniz:
https://github.com/$Repo/releases/tag/$Version
"@
    }
    Write-OK "Kurulum dosyası: $fileName"

    # ── İndir ─────────────────────────────────────────────────────────────
    $dest = Join-Path $tmp $fileName
    Write-Step "İndiriliyor…"
    $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest'i hızlandırır
    Invoke-WebRequest -Uri "$downloadBase/$fileName" -OutFile $dest -UseBasicParsing
    $sizeMb = [math]::Round((Get-Item $dest).Length / 1MB, 1)
    Write-OK "İndirildi ($sizeMb MB)"

    # ── SHA256 doğrula ────────────────────────────────────────────────────
    # İmzasız olduğu için tek güvence bu: özet tutmazsa kurmuyoruz.
    Write-Step "SHA256 doğrulanıyor…"
    $sumsPath = Join-Path $tmp 'SHA256SUMS.txt'
    $verified = $false
    try {
        Invoke-WebRequest -Uri "$downloadBase/SHA256SUMS.txt" -OutFile $sumsPath -UseBasicParsing
        $expected = $null
        foreach ($line in Get-Content $sumsPath) {
            if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') {
                if ($Matches[2] -eq $fileName) { $expected = $Matches[1].ToLower(); break }
            }
        }
        if (-not $expected) {
            Write-Warn "SHA256SUMS.txt içinde $fileName için kayıt yok — doğrulama atlandı."
        } else {
            $actual = (Get-FileHash -Algorithm SHA256 -Path $dest).Hash.ToLower()
            if ($actual -ne $expected) {
                Fail "SHA256 uyuşmuyor — indirilen dosya bozuk veya değiştirilmiş." @"
Beklenen: $expected
Bulunan : $actual
Kurulum yapılmadı. Dosyayı silin ve tekrar deneyin.
"@
            }
            $verified = $true
            Write-OK "SHA256 doğrulandı"
        }
    } catch [System.Management.Automation.RuntimeException] {
        throw
    } catch {
        Write-Warn "SHA256SUMS.txt indirilemedi ($($_.Exception.Message)) — doğrulama atlandı."
    }

    if (-not $verified) {
        Write-Warn "Bu indirme doğrulanamadı. Devam etmek istemiyorsanız Ctrl+C ile durdurun."
    }

    # ── Kur ───────────────────────────────────────────────────────────────
    Write-Step "Kuruluyor… (yönetici onayı istenebilir)"
    if ($installerKind -eq 'nsis') {
        # /S = sessiz kurulum (NSIS standardı).
        $proc = Start-Process -FilePath $dest -ArgumentList '/S' -Wait -PassThru
        if ($proc.ExitCode -ne 0) {
            Fail "Kurulum başarısız oldu (çıkış kodu: $($proc.ExitCode))." "Kurulum dosyasını elle çalıştırmayı deneyin: $dest"
        }
    } else {
        $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', "`"$dest`"", '/qn', '/norestart') -Wait -PassThru
        if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
            Fail "Kurulum başarısız oldu (çıkış kodu: $($proc.ExitCode))." "Kurulum dosyasını elle çalıştırmayı deneyin: $dest"
        }
    }
    Write-OK "Kurulum tamamlandı"

    Write-Host ""
    Write-Host "  $AppName $Version hazır." -ForegroundColor Green
    Write-Host "  Başlat menüsünden ya da masaüstü kısayolundan açabilirsiniz." -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  İlk açılışta:" -ForegroundColor DarkGray
    Write-Host "   • Uygulama yerel bir profil oluşturur (hesap/şifre yok)." -ForegroundColor DarkGray
    Write-Host "   • Yanıt almak için Ayarlar → Sağlayıcılar'dan bir model anahtarı ekleyin," -ForegroundColor DarkGray
    Write-Host "     ya da yerel bir model (Ollama) bağlayın." -ForegroundColor DarkGray
    Write-Host "   • Dosya gezgini, terminal ve sıkıştırma motoru anahtarsız da çalışır." -ForegroundColor DarkGray
    Write-Host ""
} finally {
    if (Test-Path $tmp) { Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
} catch {
    # Fail() kendi mesajını yazdırdı; burada yalnız beklenmeyen hatalar için
    # tek satır ekliyoruz ve hatayı YUTUYORUZ (yeniden fırlatmak trace basar).
    if ($_.Exception.Message -notlike '*Thalamus kurulumu durduruldu*') {
        Write-Host "[HATA] Beklenmeyen hata: $($_.Exception.Message)" -ForegroundColor Red
    }
}
