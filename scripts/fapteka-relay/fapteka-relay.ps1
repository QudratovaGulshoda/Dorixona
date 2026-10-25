# F-Apteka -> ERP ko'prigi
#
# Oddiy ishlatish (bugun + kecha, hamma hisobot):
#   powershell -NoProfile -ExecutionPolicy Bypass -File fapteka-relay.ps1
#
# Eski kirimlardan tan narxni tortish (bir martalik, harajat yozilmaydi):
#   ... -File fapteka-relay.ps1 -Days 120 -Only incoming -CostOnly
#
# Ikkita Windows vazifasi bo'ladi (README ga qarang):
#   "FApteka ERP"        - har 15 daqiqada, bugun + kecha
#   "FApteka ERP kunlik" - kuniga bir marta, oxirgi 30 kunni qayta yozadi
#   (ikkinchisi eski yozuvlarni o'zi tuzatib turadi)
#
# F-Apteka hisobot API'si (P_GetReport_XML) dorixonaning ichki tarmog'ida
# turadi, internetdan unga kirib bo'lmaydi. Bu skript dorixona kompyuterida
# ishlaydi: har safar bugun va kechagi savdo, kirim, qaytarish va
# spisanieni API'dan oladi va ERP saytiga yuboradi.
#
# O'rnatish: shu papkadagi README.md

param(
  [int]$Days,                # nechta kun ortga: bugun + oldingi kunlar
  [string]$Only,             # faqat bitta hisobot, masalan: incoming
  [switch]$CostOnly,         # kirimdan faqat tan narx olinadi
  [switch]$WithExpenses      # (eskirgan: kirim endi doim harajat sifatida yoziladi)
)

# ---- Sozlamalar ------------------------------------------------------------
# API shu kompyuterning o'zida ishlaydi (127.0.0.1:8081 LISTENING), shuning
# uchun localhost. Tarmoq manzili (192.168.0.x) router qayta yonganda
# o'zgarib qoladi - localhost esa hech qachon o'zgarmaydi.
$ApiUrl  = "http://localhost:8081/P_GetReport_XML"
# Hisobot xizmatining Windows dagi nomi. API javob bermasa shu qayta yoqiladi.
$ServiceName = "ServiceReport"
# Qayta yoqishlar orasidagi eng kam vaqt (daqiqa) - tinimsiz urinmasin
$RestartCooldownMinutes = 30
$ErpUrl  = "https://dorixonaa.vercel.app/api/integrations/fapteka/report"
# Narx nazorati: har ishga tushganda bir necha dorining narxi yangilanadi.
# Ro'yxat uch soatda to'liq aylanadi.
$PriceUrl = "https://dorixonaa.vercel.app/api/prices/refresh"
# Qarz eslatmasi: muddati yaqin qarzlar Telegram'ga yuboriladi.
# Server kuniga bir marta yuboradi, shuning uchun bu turtki xavfsiz.
$DebtUrl = "https://dorixonaa.vercel.app/api/notifications/debts"
# Kirim hujjatlari to'g'ridan-to'g'ri F-Apteka bazasidan olinadi.
# Sabab: 20-hisobotda "SELECT TOP 1 *" turibdi - bir so'rovga bitta
# hujjat qaytaradi, qolgani yo'qoladi va qarz yarim ko'rinadi.
# Login va parol skriptda EMAS - yonidagi sql.txt faylida, faqat shu
# kompyuterda turadi (skript GitHub'da ochiq). Fayl yo'q bo'lsa bu qism
# o'tkazib yuboriladi. sql.txt ni install-tasks.ps1 o'zi yaratadi, qo'lda:
#   Server=localhost;Database=NAPTSKLAD;User Id=<login>;Password=<parol>;TrustServerCertificate=True
$SqlUrl  = "https://dorixonaa.vercel.app/api/integrations/fapteka/sql"
$SqlConn = ""
$SqlFile = Join-Path $PSScriptRoot "sql.txt"
if (Test-Path $SqlFile) { $SqlConn = (Get-Content $SqlFile -Raw).Trim() }
# Kunlik xulosa (kechqurun) va ombor ogohlantirishi (ertalab). Qaysi
# paytda yuborishni server o'zi hal qiladi, bu yerda faqat turtki beramiz.
$NoticeUrls = [ordered]@{
  "kunlik xulosa"      = "https://dorixonaa.vercel.app/api/notifications/kunlik"
  "ombor eslatmasi"    = "https://dorixonaa.vercel.app/api/notifications/ombor"
  # Arzonaptekadagi dorilardan narxi tavsiyaga mos kelmaganlari (10:00 dan keyin)
  "narx eslatmasi"     = "https://dorixonaa.vercel.app/api/notifications/narx"
  # Doimiy xarajatlar har oy 5-sanada shu oyga ko'chiriladi - Vercel Cron'ga
  # bog'liq bo'lmasin; oyiga bir marta ishlaydi, keyin "already" qaytaradi
  "doimiy xarajatlar"  = "https://dorixonaa.vercel.app/api/expenses/recurring"
}
$Token   = "BU_YERGA_TOKEN"            # Vercel'dagi FAPTEKA_SITE_TOKEN (SITE.exe TOCING bilan bir xil)
$Filials = @("2", "3")                 # 2 = Yunusobod, 3 = Shayxontohur
# Kirim va yetkazib beruvchiga qaytarish omborga (filial 1) yoziladi,
# dorixonalarga emas - shuning uchun ular boshqa filialdan so'raladi.
$ReportFilials = @{
  catalog        = @("1")
  incoming       = @("1")
  incomingTotals = @("1")
  supplierReturn = @("1")
  organizations  = @("1")
}

# Tashkilotlar ro'yxati sanaga bog'liq emas - har kun emas, run boshiga bir marta
$OnceReports = @("organizations", "catalog")
$DaysDefault = 2                       # bugun + kecha
# Bu dorixonadagi API'da Ver.2 hisobotlari (14, 15, 11, 12) bo'sh qaytaradi,
# shuning uchun eski raqamlar ishlatiladi. API yangilansa, chap ustundagi
# nomni V2 ga (masalan retailSaleV2 = 14) o'zgartirish kifoya - ikkalasini
# birga qoldirmang, savdo ikki marta yozilib qoladi.
# Tartib muhim: avval tovar kesimidagi hisobot, keyin tuzatuvchisi.
# 22 savdodagi tan narxni, 20 esa harajatdagi yetkazib beruvchi nomini
# to'g'rilaydi - shuning uchun ular 4 va 1 dan keyin turadi.
$Reports = [ordered]@{
  retailSale     = 4                   # Roznichnaya prodazha (tovar kesimida)
  salesTotals    = 22                  # Prodazhi - tan narx bilan (tuzatilgan)
  insuranceSale  = 5                   # Strahovka prodazha
  incoming       = 1                   # Prihody na sklad (tovar kesimida)
  incomingTotals = 20                  # Prihody - yetkazib beruvchi bilan (tuzatilgan)
  supplierReturn = 2                   # Vozvrat postavshchiku
  writeOff       = 3                   # Spisanie
  payments       = 30                  # PAYIN - kassaga tushgan pul (naqd/terminal)
  organizations  = 189                 # Spravochnik organizatsiy
  catalog        = 188                 # Spravochnik tovarov (nom va toifa)
}
# ----------------------------------------------------------------------------

if (-not $Days) { $Days = $DaysDefault }
if ($Only -eq "revaluation" -or $Only -eq "shifts" -or $Only -eq "suppliers") {
  # Faqat bazadan olinadigan qism - API hisobotlari o'tkazib yuboriladi
  $Reports = [ordered]@{}
} elseif ($Only) {
  if (-not $Reports.Contains($Only)) {
    Write-Output "XATO  Bunday hisobot yo'q: $Only"
    exit 1
  }
  $single = [ordered]@{}
  $single[$Only] = $Reports[$Only]
  $Reports = $single
}
# Kirim hujjatlari harajat sifatida ham yoziladi ("F-Apteka kirim #..."),
# shu bilan birga tovarlarning tan narxi yangilanadi.
# Eski kunlarni faqat tan narx uchun tortmoqchi bo'lsangiz: -CostOnly
$CostOnlyReports = @()

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# Ulanishlarni qayta ishlatish - har so'rovda yangi TLS qo'l berishuvi bo'lmasin
[Net.ServicePointManager]::DefaultConnectionLimit = 8
[Net.ServicePointManager]::Expect100Continue = $false
$LogFile = Join-Path $PSScriptRoot "relay.log"
if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 5MB) { Remove-Item $LogFile }

function Write-Log([string]$Text) {
  $line = "{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $Text
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
  # Write-Output emas: u matnni quvurga ham chiqaradi va log yozadigan
  # funksiyaning qaytargan qiymatiga qo'shilib ketadi. Write-Host faqat
  # ekranga yozadi, fayl esa yuqorida saqlandi.
  Write-Host $line
}

# Xato bo'lsa, server javobining matnini ham ko'rsatadi
function Get-ErrorText($ErrorRecord) {
  $err = $ErrorRecord.Exception
  while ($err -and -not ($err -is [System.Net.WebException])) { $err = $err.InnerException }
  if ($err -and $err.Response) {
    $reader = New-Object System.IO.StreamReader($err.Response.GetResponseStream())
    return "$($err.Message) $($reader.ReadToEnd())"
  }
  return $ErrorRecord.Exception.Message
}

# Token skript ichida yozilmagan bo'lsa, yonidagi token.txt dan olinadi
if ($Token -eq "BU_YERGA_TOKEN") {
  $TokenFile = Join-Path $PSScriptRoot "token.txt"
  if (Test-Path $TokenFile) { $Token = (Get-Content $TokenFile -Raw).Trim() }
}
if ($Token -eq "BU_YERGA_TOKEN" -or -not $Token) {
  Write-Log "XATO  Token yo'q: skriptdagi `$Token qatoriga yozing yoki token.txt fayl qiling"
  exit 1
}

Write-Log "relay v28 boshlandi (narx eslatmasi)"

# ---- Avval F-Apteka API ishlayotganini tekshiramiz ------------------------
# Aks holda har kun uchun bir xil "ulanib bo'lmadi" xatosi chiqib, sabab
# noaniq qolardi: API o'chiqmi yoki internetmi.
$ApiError = ""

function Test-FaptekaApi {
  try {
    $ping = New-Object System.Net.WebClient
    $probe = "{0}?pDateFrom={1}&pDateTo={1}&pFilial_id=2&pReport_id=4" -f $ApiUrl, (Get-Date).ToString("dd.MM.yyyy")
    [void]$ping.DownloadData($probe)
    return $true
  } catch {
    $script:ApiError = Get-ErrorText $_
    return $false
  }
}

# Kompyuter yoqilganda xizmat tarmoq tayyor bo'lmasdan turib boshlanib,
# 8081-portni egallay olmay to'xtab qolishi mumkin ("Could not bind socket").
# O'sha holatda xizmatni qayta yoqishning o'zi yetadi. Skript vazifa
# rejalashtiruvchida SYSTEM nomidan ishlagani uchun buning huquqi bor.
$RestartDone = $false

function Restart-FaptekaService {
  $script:RestartDone = $false
  $stamp = Join-Path $PSScriptRoot "restart.stamp"
  if (Test-Path $stamp) {
    $last = (Get-Item $stamp).LastWriteTime
    $passed = (New-TimeSpan -Start $last -End (Get-Date)).TotalMinutes
    if ($passed -lt $RestartCooldownMinutes) {
      Write-Log ("      Yaqinda urinib ko'rilgan ({0:N0} daqiqa oldin), kutamiz" -f $passed)
      return
    }
  }
  Set-Content -Path $stamp -Value (Get-Date).ToString("s") -Encoding ASCII

  try {
    Write-Log ("      Xizmatni qayta yoqamiz: {0}" -f $ServiceName)
    Restart-Service -Name $ServiceName -Force -ErrorAction Stop
    $script:RestartDone = $true
    # Xizmat 8081-portni darrov ochmaydi (10 soniya yetmagan edi) -
    # 90 soniyagacha har 5 soniyada tekshiramiz
    for ($try = 0; $try -lt 18; $try++) {
      Start-Sleep -Seconds 5
      if (Test-FaptekaApi) { break }
    }
  } catch {
    Write-Log ("XATO  Xizmat qayta yoqilmadi: {0}" -f $_.Exception.Message)
    Write-Log "      Administrator huquqi kerak bo'lishi mumkin. Qo'lda:"
    Write-Log "      net stop ServiceReport   va   net start ServiceReport"
  }
}

$ApiOk = $true
if (Test-FaptekaApi) {
  Write-Log "OK    F-Apteka API javob berdi"
} else {
  Write-Log ("XATO  F-Apteka API javob bermadi: {0}" -f $ApiError)
  Write-Log ("      Manzil: {0}" -f $ApiUrl)

  Restart-FaptekaService
  if ($RestartDone -and (Test-FaptekaApi)) {
    Write-Log "OK    Xizmat qayta yoqildi, API javob berdi - davom etamiz"
  } else {
    if ($RestartDone) { Write-Log ("XATO  Qayta yoqilgandan keyin ham javob yo'q: {0}" -f $ApiError) }
    Write-Log "      Tekshiring: 1) ServiceReports / API dasturi ishlab turibdimi"
    Write-Log "                  2) cmd da: netstat -ano | findstr :8081  -> LISTENING bo'lsin"
    Write-Log "                  3) brauzerda shu manzilni ochib ko'ring, XML chiqishi kerak"
    # API hisobotlarisiz davom etamiz: kirim hujjatlari va pereotsenka
    # bazadan olinadi, eslatmalar ham ketadi
    Write-Log "      API hisobotlari o'tkazib yuboriladi, bazadan olinadiganlari davom etadi"
    $ApiOk = $false
  }
}

for ($i = $Days - 1; $i -ge 0; $i--) {
  if (-not $ApiOk) { break }
  $day = (Get-Date).Date.AddDays(-$i)
  $apiDate = $day.ToString("dd.MM.yyyy")
  $erpDate = $day.ToString("yyyy-MM-dd")

  foreach ($report in $Reports.Keys) {
    # Bir martalik hisobotlar faqat oxirgi kun aylanishida yuboriladi
    if (($OnceReports -contains $report) -and ($i -ne 0)) { continue }
    $reportId = $Reports[$report]
    # Nom $ReportFilials dan farq qilishi shart: PowerShell'da o'zgaruvchi
    # nomlari katta-kichik harfni ajratmaydi, aks holda jadval buziladi.
    $useFilials = $Filials
    if ($ReportFilials.ContainsKey($report)) { $useFilials = $ReportFilials[$report] }

    foreach ($filial in $useFilials) {
      $label = "$erpDate F=$filial $report (#$reportId)"
      $CostSuffix = ""
      if ($CostOnly -or $CostOnlyReports -contains $report) { $CostSuffix = "&costOnly=1" }
      # Ikki qadam alohida ushlanadi, shunda xato qaysi tomondan
      # kelgani darrov ko'rinadi: F-Apteka API mi yoki ERP sayti mi.
      $xml = $null
      $contentType = "text/xml"
      try {
        $api = New-Object System.Net.WebClient
        $source = "{0}?pDateFrom={1}&pDateTo={1}&pFilial_id={2}&pReport_id={3}" -f $ApiUrl, $apiDate, $filial, $reportId
        $xml = $api.DownloadData($source)
        if ($api.ResponseHeaders["Content-Type"]) { $contentType = $api.ResponseHeaders["Content-Type"] }
      } catch {
        Write-Log ("XATO  {0}  F-APTEKA: {1}" -f $label, (Get-ErrorText $_))
        continue
      }

      # Bo'sh javobni (o'sha kuni hujjat yo'q) serverga yubormaymiz -
      # 120 kunlik tortishda shu keraksiz so'rovlar butun vaqtni yeb qo'yadi.
      #
      # Hujjat bo'lmasa F-Apteka XML emas, shunchaki shuni qaytaradi:
      #   <HTML><BODY><B>200 OK</B></BODY></HTML>
      # Bu 39 bayt - eski 40 baytlik o'lchov bilan chegarada turardi.
      # Bitta ortiqcha satr belgisi qo'shilsa, shu "javob" ERP ga hisobot
      # sifatida ketardi. Shuning uchun matnning o'ziga qaraymiz.
      $short = ""
      if ($xml.Length -lt 200) { $short = [System.Text.Encoding]::UTF8.GetString($xml) }
      if ($xml.Length -lt 40 -or $short -match "200\s*OK") {
        Write-Log ("BOSH  {0}" -f $label)
        continue
      }

      try {
        $erp = New-Object System.Net.WebClient
        $erp.Headers.Add("Authorization", "Bearer $Token")
        $erp.Headers.Add("Content-Type", $contentType)
        $target = "{0}?report={1}&filial={2}&dateFrom={3}&dateTo={3}{4}" -f $ErpUrl, $report, $filial, $erpDate, $CostSuffix
        $answer = [System.Text.Encoding]::UTF8.GetString($erp.UploadData($target, "POST", $xml))
        Write-Log ("OK    {0}  {1} bayt  {2}" -f $label, $xml.Length, $answer)
      } catch {
        Write-Log ("XATO  {0}  ERP: {1}" -f $label, (Get-ErrorText $_))
      }
    }
  }
}

# ---- Kirim hujjatlari bazadan --------------------------------------------
# 20-hisobotdagi TOP 1 ni aylanib o'tamiz: hujjatlarni to'g'ridan-to'g'ri
# MSSQL dan o'qib, 20-hisobot maydonlari nomi bilan yuboramiz (N, O, D, SS).
# Shunda ERP tomondagi mavjud kod o'zgarishsiz ishlayveradi.
function Send-IncomeDocs([datetime]$From, [datetime]$To) {
  $fromText = $From.ToString("yyyy-MM-dd")
  $toText   = $To.ToString("yyyy-MM-dd")
  $label    = "kirim hujjatlari $fromText..$toText"

  if (-not $SqlConn) {
    Write-Log ("BOSH  {0}  (sql.txt yo'q - bazaga ulanish sozlanmagan)" -f $label)
    return
  }

  try {
    $conn = New-Object System.Data.SqlClient.SqlConnection($SqlConn)
    $conn.Open()
    $cmd = $conn.CreateCommand()
    # Qaysi hujjat olinadi (butun baza bo'yicha sanab aniqlangan):
    #   DOCTYPE 19 STATE 3 - 5796 ta, 67.3 mlrd  <- asosiy kirim
    #   DOCTYPE 1  STATE 3 -  990 ta, 10.1 mlrd  <- kirimning ikkinchi turi
    #   DOCTYPE 9  STATE 12 -  16 ta,  1.27 mlrd <- boshqa tur, olinmaydi
    #   STATE 2            -    8 ta             <- qoralama/bekor, olinmaydi
    # Ya'ni hujjatlarning 99.6% i olinadi, g'alati turlari chetlatiladi:
    # noto'g'ri qarz yozilgandan ko'ra yozilmagani yaxshi.
    $cmd.CommandText = @"
SELECT i.NUMBER AS N, i.ORG AS O,
       CONVERT(varchar(10), i.DATA, 120) AS D,
       i.SUMMAPOZ AS SS,
       CONVERT(varchar(10), i.DATAOTS, 120) AS DOTS,
       i.STATE AS ST, i.DOCTYPE AS DT, i.OTDEL AS OTD
FROM INCOME i
WHERE i.DATA >= @f AND i.DATA < DATEADD(day, 1, @t)
  AND i.SUMMAPOZ > 0 AND i.STATE = 3 AND i.DOCTYPE IN (1, 19)
ORDER BY i.DATA, i.NUMBER
"@
    [void]$cmd.Parameters.AddWithValue("@f", $From.Date)
    [void]$cmd.Parameters.AddWithValue("@t", $To.Date)

    $rows = @()
    $reader = $cmd.ExecuteReader()
    while ($reader.Read()) {
      $rows += [ordered]@{
        N = [string]$reader["N"]
        O = [string]$reader["O"]
        D = [string]$reader["D"]
        SS = [string]$reader["SS"]
        DOTS = [string]$reader["DOTS"]
        ST = [string]$reader["ST"]
        DT = [string]$reader["DT"]
        OTD = [string]$reader["OTD"]
      }
    }
    $reader.Close()
    $conn.Close()
  } catch {
    Write-Log ("XATO  {0}  BAZA: {1}" -f $label, $_.Exception.Message)
    return
  }

  if ($rows.Count -eq 0) {
    Write-Log ("BOSH  {0}" -f $label)
    return
  }

  try {
    $body = @{ kind = "incomingDocs"; dateFrom = $fromText; dateTo = $toText; rows = @($rows) } |
            ConvertTo-Json -Depth 4 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $api = New-Object System.Net.WebClient
    $api.Headers.Add("Authorization", "Bearer $Token")
    $api.Headers.Add("Content-Type", "application/json; charset=utf-8")
    $answer = [System.Text.Encoding]::UTF8.GetString($api.UploadData($SqlUrl, "POST", $bytes))
    Write-Log ("OK    {0}  {1} hujjat  {2}" -f $label, $rows.Count, $answer)
  } catch {
    Write-Log ("XATO  {0}  ERP: {1}" -f $label, (Get-ErrorText $_))
  }
}

if (-not $Only) {
  Send-IncomeDocs (Get-Date).Date.AddDays(-($Days - 1)) (Get-Date).Date
}

# ---- Pereotsenka bazadan ---------------------------------------------------
# Dorixonalar (otdel 2, 3) ma'lumoti NGLOBAL bazasida (NAPTSKLAD - faqat
# ombor). REVAL + REVALLN dan kun x otdel jamlanmasi olinadi; summasi
# F-Apteka "Pereocenka" oynasidagi "Summa 1" bilan tiyinigacha bir xil
# (28.09.2026 da hujjatma-hujjat tekshirilgan). Faqat yopilgan hujjatlar
# (STATE = 12). Butun oy yuboriladi - ERP o'sha oyni to'liq almashtiradi;
# oyning birinchi 5 kunida o'tgan oy ham qayta yuboriladi.
function Send-Revaluation([datetime]$MonthStart) {
  $monthEnd = $MonthStart.AddMonths(1)
  $label = "pereotsenka {0:yyyy-MM}" -f $MonthStart
  $inv = [Globalization.CultureInfo]::InvariantCulture

  try {
    $conn = New-Object System.Data.SqlClient.SqlConnection($SqlConn)
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = @"
SELECT CONVERT(varchar(10), r.DATA, 120) AS D, r.OTDEL AS OTD, COUNT(DISTINCT r.ID) AS N,
       SUM(l.KOL * (l.PRICEROZNEW - l.PRICEROZOLD)) AS S,
       SUM(l.KOL * (l.PRICEROZ1NEW - l.PRICEROZ1OLD)) AS S1
FROM [NGLOBAL].dbo.REVAL r
JOIN [NGLOBAL].dbo.REVALLN l ON l.REVAL = r.ID
WHERE r.STATE = 12 AND r.DATA >= @f AND r.DATA < @t
GROUP BY CONVERT(varchar(10), r.DATA, 120), r.OTDEL
"@
    [void]$cmd.Parameters.AddWithValue("@f", $MonthStart)
    [void]$cmd.Parameters.AddWithValue("@t", $monthEnd)
    $rows = @()
    $reader = $cmd.ExecuteReader()
    while ($reader.Read()) {
      $s  = 0; if ($reader["S"]  -isnot [DBNull]) { $s  = [decimal]$reader["S"] }
      $s1 = 0; if ($reader["S1"] -isnot [DBNull]) { $s1 = [decimal]$reader["S1"] }
      $rows += [ordered]@{
        D   = [string]$reader["D"]
        OTD = [string]$reader["OTD"]
        N   = [string]$reader["N"]
        S   = $s.ToString($inv)
        S1  = $s1.ToString($inv)
      }
    }
    $reader.Close()
    $conn.Close()
  } catch {
    Write-Log ("XATO  {0}  BAZA: {1}" -f $label, $_.Exception.Message)
    return
  }

  try {
    $body = @{ kind = "revaluation"; dateFrom = $MonthStart.ToString("yyyy-MM-dd");
               dateTo = $monthEnd.AddDays(-1).ToString("yyyy-MM-dd"); rows = @($rows) } |
            ConvertTo-Json -Depth 4 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $api = New-Object System.Net.WebClient
    $api.Headers.Add("Authorization", "Bearer $Token")
    $api.Headers.Add("Content-Type", "application/json; charset=utf-8")
    $answer = [System.Text.Encoding]::UTF8.GetString($api.UploadData($SqlUrl, "POST", $bytes))
    Write-Log ("OK    {0}  {1} qator  {2}" -f $label, $rows.Count, $answer)
  } catch {
    Write-Log ("XATO  {0}  ERP: {1}" -f $label, (Get-ErrorText $_))
  }
}

if ((-not $Only -or $Only -eq "revaluation") -and $SqlConn) {
  $thisMonth = Get-Date -Day 1 -Hour 0 -Minute 0 -Second 0 -Millisecond 0
  if ($Days -gt 31) {
    # Orqaga to'ldirish (-Days 365): o'sha kun tushgan oydan joriy oygacha
    $back = (Get-Date).AddDays(-$Days)
    $m = Get-Date -Year $back.Year -Month $back.Month -Day 1 -Hour 0 -Minute 0 -Second 0 -Millisecond 0
    while ($m -le $thisMonth) { Send-Revaluation $m; $m = $m.AddMonths(1) }
  } else {
    if ((Get-Date).Day -le 5) { Send-Revaluation $thisMonth.AddMonths(-1) }
    Send-Revaluation $thisMonth
  }
}

# ---- Kassir smenalari bazadan ---------------------------------------------
# Har chekda kassir (USERS) va smena (SMENA) yozilgan. F-Apteka'ning SMENA
# jadvali eskirgan, shuning uchun smena cheklardan tuziladi. Bitta SMENA
# kunlab ochiq turishi mumkin - ish kuni bo'yicha bo'linadi (06:00 dan
# 06:00 gacha: yarim tundan keyin tugagan smena o'z kuniga yoziladi).
function Send-Shifts([datetime]$From, [datetime]$To) {
  $label = "smenalar {0:yyyy-MM-dd}..{1:yyyy-MM-dd}" -f $From, $To.AddDays(-1)
  $inv = [Globalization.CultureInfo]::InvariantCulture
  try {
    $conn = New-Object System.Data.SqlClient.SqlConnection($SqlConn)
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandTimeout = 300
    $cmd.CommandText = @"
SELECT i.OTDEL AS OTD,
       CAST(i.SMENA AS varchar(20)) + ':' + CONVERT(varchar(8), DATEADD(hour, -6, i.DATAENTER), 112) AS SM,
       i.USERS AS U, MAX(u.NAME) AS NAME,
       CONVERT(varchar(19), MIN(i.DATAENTER), 126) AS A,
       CONVERT(varchar(19), MAX(i.DATAENTER), 126) AS B,
       SUM(CASE WHEN i.DOCTYPE = 2 THEN 1 ELSE 0 END) AS C,
       SUM(CASE WHEN i.DOCTYPE = 2 THEN i.SUMMA ELSE 0 END) AS S,
       SUM(CASE WHEN i.DOCTYPE = 4 THEN ABS(i.SUMMA) ELSE 0 END) AS R,
       SUM(CASE WHEN i.DOCTYPE = 2 THEN ISNULL(lc.COST, 0) ELSE 0 END) AS CS,
       SUM(CASE WHEN i.DOCTYPE = 4 THEN ISNULL(lc.COST, 0) ELSE 0 END) AS CR
FROM [NGLOBAL].dbo.INVOICE i
LEFT JOIN [NGLOBAL].dbo.USERS u ON u.ID = i.USERS
-- Tan narx: 22-hisobot bilan bir xil (KOL x INCOMELN.PRICESKID), chek bo'yicha.
-- 03.10.2026 da tekshirilgan: Shayxontohur 25 552 908 - 22-hisobot bilan aynan.
LEFT JOIN (
  SELECT l.INVOICE, SUM(ABS(l.KOL) * x.PRICESKID) AS COST
  FROM [NGLOBAL].dbo.INVOICELN l
  JOIN [NGLOBAL].dbo.INCOMELN x ON x.ID = l.INCOMELN
  JOIN [NGLOBAL].dbo.INVOICE ii ON ii.ID = l.INVOICE
  WHERE ii.DOCTYPE IN (2, 4) AND ii.DATA >= @f AND ii.DATA < @t
  GROUP BY l.INVOICE
) lc ON lc.INVOICE = i.ID
WHERE i.DOCTYPE IN (2, 4) AND i.SMENA IS NOT NULL AND i.USERS IS NOT NULL
  AND i.DATA >= @f AND i.DATA < @t
GROUP BY i.OTDEL, i.SMENA, i.USERS, CONVERT(varchar(8), DATEADD(hour, -6, i.DATAENTER), 112)
"@
    [void]$cmd.Parameters.AddWithValue("@f", $From)
    [void]$cmd.Parameters.AddWithValue("@t", $To)
    $rows = @()
    $reader = $cmd.ExecuteReader()
    while ($reader.Read()) {
      $sum = 0; if ($reader["S"] -isnot [DBNull]) { $sum = [decimal]$reader["S"] }
      $ret = 0; if ($reader["R"] -isnot [DBNull]) { $ret = [decimal]$reader["R"] }
      $cs = 0; if ($reader["CS"] -isnot [DBNull]) { $cs = [decimal]$reader["CS"] }
      $cr = 0; if ($reader["CR"] -isnot [DBNull]) { $cr = [decimal]$reader["CR"] }
      $rows += [ordered]@{
        OTD  = [string]$reader["OTD"]
        SM   = [string]$reader["SM"]
        U    = [string]$reader["U"]
        NAME = [string]$reader["NAME"]
        A    = [string]$reader["A"]
        B    = [string]$reader["B"]
        C    = [string]$reader["C"]
        S    = $sum.ToString($inv)
        R    = $ret.ToString($inv)
        CS   = $cs.ToString($inv)
        CR   = $cr.ToString($inv)
      }
    }
    $reader.Close()
    $conn.Close()
  } catch {
    Write-Log ("XATO  {0}  BAZA: {1}" -f $label, $_.Exception.Message)
    return
  }
  if ($rows.Count -eq 0) { Write-Log ("BOSH  {0}" -f $label); return }

  try {
    $body = @{ kind = "shifts"; dateFrom = $From.ToString("yyyy-MM-dd");
               dateTo = $To.AddDays(-1).ToString("yyyy-MM-dd"); rows = @($rows) } |
            ConvertTo-Json -Depth 4 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $api = New-Object System.Net.WebClient
    $api.Headers.Add("Authorization", "Bearer $Token")
    $api.Headers.Add("Content-Type", "application/json; charset=utf-8")
    $answer = [System.Text.Encoding]::UTF8.GetString($api.UploadData($SqlUrl, "POST", $bytes))
    Write-Log ("OK    {0}  {1} smena  {2}" -f $label, $rows.Count, $answer)
  } catch {
    Write-Log ("XATO  {0}  ERP: {1}" -f $label, (Get-ErrorText $_))
  }
}

if ((-not $Only -or $Only -eq "shifts") -and $SqlConn) {
  # Bir kun oldindan boshlanadi - kechki smena yarim tundan oshgan bo'lishi mumkin
  Send-Shifts (Get-Date).Date.AddDays(-$Days) (Get-Date).Date.AddDays(1)
}

# ---- Yetkazib beruvchilar bazadan -----------------------------------------
# Har kirim qatorida yetkazib beruvchi bor, har chek qatori
# esa qaysi kirim partiyasidan sotilganini ko'rsatadi (INVOICELN.INCOMELN).
#   goodSuppliers  - har tovarning oxirgi yetkazib beruvchisi (qoldiq uchun);
#                    kuniga bir marta (kunlik vazifa) yoki -Only suppliers
#   supplierSales  - joriy oy savdosi yetkazib beruvchi bo'yicha, har safar
# Dorixonaga tovar ombordan ko'chirib keladi - u yerdagi ORG ombor bo'ladi.
# Haqiqiy firma FIRSTORG da (ko'chirishlarda o'zgarmaydi), bo'sh bo'lsa ORG.
function Send-SqlRows([string]$Kind, [string]$From, [string]$To, $Rows, [string]$Label) {
  try {
    $body = @{ kind = $Kind; dateFrom = $From; dateTo = $To; rows = @($Rows) } | ConvertTo-Json -Depth 4 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $api = New-Object System.Net.WebClient
    $api.Headers.Add("Authorization", "Bearer $Token")
    $api.Headers.Add("Content-Type", "application/json; charset=utf-8")
    $answer = [System.Text.Encoding]::UTF8.GetString($api.UploadData($SqlUrl, "POST", $bytes))
    Write-Log ("OK    {0}  {1} qator  {2}" -f $Label, @($Rows).Count, $answer)
  } catch {
    Write-Log ("XATO  {0}  ERP: {1}" -f $Label, (Get-ErrorText $_))
  }
}

function Send-Suppliers([bool]$WithGoods) {
  $inv = [Globalization.CultureInfo]::InvariantCulture
  $monthStart = Get-Date -Day 1 -Hour 0 -Minute 0 -Second 0 -Millisecond 0
  if ((Get-Date).Day -le 5) { $monthStart = $monthStart.AddMonths(-1) }
  # Orqaga to'ldirish: -Days 365 -> o'sha kun tushgan oy boshidan
  if ($Days -gt 31) {
    $back = (Get-Date).AddDays(-$Days)
    $monthStart = Get-Date -Year $back.Year -Month $back.Month -Day 1 -Hour 0 -Minute 0 -Second 0 -Millisecond 0
  }
  $monthEnd = (Get-Date -Day 1 -Hour 0 -Minute 0 -Second 0 -Millisecond 0).AddMonths(1)
  try {
    $conn = New-Object System.Data.SqlClient.SqlConnection($SqlConn)
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandTimeout = 300

    if ($WithGoods) {
      $cmd.CommandText = @"
SELECT x.GOOD AS G, x.ORG AS O FROM (
  SELECT GOOD, ISNULL(NULLIF(FIRSTORG, 0), ORG) AS ORG,
         ROW_NUMBER() OVER (PARTITION BY GOOD ORDER BY DATA DESC, ID DESC) AS rn
  FROM [NGLOBAL].dbo.INCOMELN WHERE STATE = 3 AND ISNULL(NULLIF(FIRSTORG, 0), ORG) IS NOT NULL
) x WHERE x.rn = 1
"@
      $goods = @()
      $reader = $cmd.ExecuteReader()
      while ($reader.Read()) { $goods += [ordered]@{ G = [string]$reader["G"]; O = [string]$reader["O"] } }
      $reader.Close()
      $today = (Get-Date).ToString("yyyy-MM-dd")
      Send-SqlRows "goodSuppliers" $today $today $goods "tovar -> yetkazib beruvchi"
    }

    $cmd.CommandText = @"
SELECT CONVERT(varchar(7), i.DATA, 120) AS M, i.OTDEL AS OTD, ISNULL(NULLIF(x.FIRSTORG, 0), x.ORG) AS O,
       SUM(CASE WHEN i.DOCTYPE = 2 THEN l.KOL * l.PRICE ELSE -ABS(l.KOL * l.PRICE) END) AS S,
       SUM(CASE WHEN i.DOCTYPE = 2 THEN l.KOL * x.PRICESKID ELSE -ABS(l.KOL * x.PRICESKID) END) AS C
FROM [NGLOBAL].dbo.INVOICE i
JOIN [NGLOBAL].dbo.INVOICELN l ON l.INVOICE = i.ID
LEFT JOIN [NGLOBAL].dbo.INCOMELN x ON x.ID = l.INCOMELN
WHERE i.DOCTYPE IN (2, 4) AND i.DATA >= @f AND i.DATA < @t
GROUP BY CONVERT(varchar(7), i.DATA, 120), i.OTDEL, ISNULL(NULLIF(x.FIRSTORG, 0), x.ORG)
"@
    [void]$cmd.Parameters.AddWithValue("@f", $monthStart)
    [void]$cmd.Parameters.AddWithValue("@t", $monthEnd)
    $sales = @()
    $reader = $cmd.ExecuteReader()
    while ($reader.Read()) {
      $sv = 0; if ($reader["S"] -isnot [DBNull]) { $sv = [decimal]$reader["S"] }
      $cv = 0; if ($reader["C"] -isnot [DBNull]) { $cv = [decimal]$reader["C"] }
      $org = ""; if ($reader["O"] -isnot [DBNull]) { $org = [string]$reader["O"] }
      $sales += [ordered]@{ M = [string]$reader["M"]; OTD = [string]$reader["OTD"]; O = $org;
                            S = $sv.ToString($inv); C = $cv.ToString($inv) }
    }
    $reader.Close()
    $conn.Close()
    Send-SqlRows "supplierSales" $monthStart.ToString("yyyy-MM-dd") $monthEnd.AddDays(-1).ToString("yyyy-MM-dd") $sales ("yetkazib beruvchi savdosi {0:yyyy-MM}.." -f $monthStart)
  } catch {
    Write-Log ("XATO  yetkazib beruvchilar  BAZA: {0}" -f $_.Exception.Message)
  }
}

if ((-not $Only -or $Only -eq "suppliers") -and $SqlConn) {
  # Tovar -> yetkazib beruvchi: kunlik vazifada (-Days 30) yoki qo'lda
  Send-Suppliers ($Only -eq "suppliers" -or $Days -ge 30)
}

# ---- Narx nazorati --------------------------------------------------------
# Raqobatchi narxlari ERP tomonda yangilanadi; bu yerda faqat turtki beramiz.
if (-not $Only) {
  try {
    $prices = New-Object System.Net.WebClient
    $prices.Headers.Add("Authorization", "Bearer $Token")
    $answer = [System.Text.Encoding]::UTF8.GetString($prices.UploadData($PriceUrl, "POST", [byte[]]@()))
    Write-Log ("OK    narx nazorati  {0}" -f $answer)
  } catch {
    Write-Log ("XATO  narx nazorati  {0}" -f (Get-ErrorText $_))
  }
}

# ---- Qarz eslatmasi -------------------------------------------------------
# Muddati yaqin qarzlarni Telegram'ga yuboradi. Vercel Cron ishlamay qolsa
# ham eslatma kelsin - shu sababli bu yerdan ham turtki beramiz. Server
# kuniga bir martadan ortiq yubormaydi.
if (-not $Only) {
  try {
    $debts = New-Object System.Net.WebClient
    $debts.Headers.Add("Authorization", "Bearer $Token")
    $answer = [System.Text.Encoding]::UTF8.GetString($debts.UploadData($DebtUrl, "POST", [byte[]]@()))
    Write-Log ("OK    qarz eslatmasi  {0}" -f $answer)
  } catch {
    Write-Log ("XATO  qarz eslatmasi  {0}" -f (Get-ErrorText $_))
  }

  foreach ($notice in $NoticeUrls.Keys) {
    try {
      $api = New-Object System.Net.WebClient
      $api.Headers.Add("Authorization", "Bearer $Token")
      $answer = [System.Text.Encoding]::UTF8.GetString($api.UploadData($NoticeUrls[$notice], "POST", [byte[]]@()))
      Write-Log ("OK    {0}  {1}" -f $notice, $answer)
    } catch {
      Write-Log ("XATO  {0}  {1}" -f $notice, (Get-ErrorText $_))
    }
  }
}

# ---- O'z-o'zini yangilash --------------------------------------------------
# Skriptlar ERP saytida turadi (token bilan). Yangisi bo'lsa yuklab olinadi,
# lekin faqat PowerShell sintaksis xatosiz o'qisa va ichida "relay v" bo'lsa
# almashtiriladi - buzuq fayl kelsa eskisi qoladi. Keyingi ishga tushishdan
# yangi versiya ishlaydi. Qo'lda yuklash shart emas.
if (-not $Only) {
  foreach ($file in "fapteka-relay.ps1", "site-watchdog.ps1") {
    $target = Join-Path $PSScriptRoot $file
    $temp = "$target.new"
    try {
      $web = New-Object System.Net.WebClient
      $web.Headers.Add("Authorization", "Bearer $Token")
      $web.DownloadFile("https://dorixonaa.vercel.app/api/integrations/fapteka/skript/$file", $temp)
      $errors = $null
      [void][System.Management.Automation.Language.Parser]::ParseFile($temp, [ref]$null, [ref]$errors)
      $text = Get-Content $temp -Raw
      $marker = if ($file -eq "fapteka-relay.ps1") { 'relay v' } else { 'SITE.exe' }
      if ($errors.Count -gt 0 -or -not $text.Contains($marker)) {
        Write-Log ("XATO  yangilash: {0} yaroqsiz keldi, eskisi qoldi" -f $file)
      } elseif (-not (Test-Path $target) -or $text -ne (Get-Content $target -Raw)) {
        Copy-Item $temp $target -Force
        Write-Log ("OK    yangilandi: {0}" -f $file)
      }
    } catch {
      Write-Log ("XATO  yangilash: {0}  {1}" -f $file, $_.Exception.Message)
    } finally {
      Remove-Item $temp -Force -ErrorAction SilentlyContinue
    }
  }
}

# API ishlamagan bo'lsa vazifa natijasi xato bo'lib ko'rinsin
if (-not $ApiOk) { exit 1 }
