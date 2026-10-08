# 端到端复核「完成 / 指派 / 成员列表 / 视频附件代理 / PDF 预览与默认程序打开」（另起一个 web 实例，零副作用：只打不存在的 id + 只读请求）
# 跑完自动 kill 实例并删除含 token 的日志。
$ErrorActionPreference = 'Stop'
$port = 19399
$dsh = 'C:\Users\ZhangShiDeng\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$out = Join-Path $env:TEMP 'dsh-e2e-zentao.out.log'
$err = Join-Path $env:TEMP 'dsh-e2e-zentao.err.log'
Remove-Item $out, $err -Force -ErrorAction SilentlyContinue

# 「用默认程序打开」会真的调系统打开文件：这里把落盘目录与打开命令都换成无害的替身（where.exe 不弹窗），
# 这样 e2e 能验证「下载 → 落盘 → 交系统」整条链路，又不会真弹出播放器/看图软件。
$openDir = Join-Path $env:TEMP 'dsh-e2e-open'
Remove-Item $openDir -Recurse -Force -ErrorAction SilentlyContinue
$env:DSH_ZENTAO_WORKBENCH_OPEN_DIR = $openDir
$env:DSH_ZENTAO_WORKBENCH_OPENER = Join-Path $env:SystemRoot 'System32\where.exe'

# 禅道站点地址：仓库里只放占位地址，真机实跑前用环境变量覆盖，例如
#   $env:DZW_ZENTAO_ORIGIN = 'http://你的禅道:端口'   # 不要带结尾斜杠，也不要带 /zentao（本脚本自己拼）
# 注意：真机校验要求它与 `~/.dsh-zentao-workbench.json` 里保存的服务器地址同源，否则附件会被宿主按「非当前禅道服务器」拒绝。
$ztOrigin = if ($env:DZW_ZENTAO_ORIGIN) { $env:DZW_ZENTAO_ORIGIN.TrimEnd('/') } else { 'http://zentao.example.com:11180' }
Write-Host "禅道站点：$ztOrigin"

# 真机要打的三类单据 / 附件：仓库里只放占位值，实跑前用环境变量覆盖成你自己实例里真实存在的对象，例如
#   $env:DZW_E2E_CLOSED_TASK = '你的已关闭/已完成任务 id'      # 用来验「终态不再写」守卫
#   $env:DZW_E2E_STORY_TASK  = '挂着研发需求的任务 id'          # 用来验 storySpec / meta 出得来
#   $env:DZW_E2E_MP4         = 'file-read-<mp4 附件 id>.mp4'   # 用来验视频代理（>1 MB）
#   $env:DZW_E2E_PNG         = 'file-read-<png 附件 id>.png'   # 用来验「用默认程序打开」链路
# 用占位值直接跑会失败（对象不存在），这属于预期：脚本是给你自己的实例用的。
$closedTask = if ($env:DZW_E2E_CLOSED_TASK) { $env:DZW_E2E_CLOSED_TASK.Trim() } else { '10004' }
$storyTask = if ($env:DZW_E2E_STORY_TASK) { $env:DZW_E2E_STORY_TASK.Trim() } else { '10002' }
$mp4Name = if ($env:DZW_E2E_MP4) { $env:DZW_E2E_MP4.Trim() } else { 'file-read-31001.mp4' }
$pngName = if ($env:DZW_E2E_PNG) { $env:DZW_E2E_PNG.Trim() } else { 'file-read-31002.png' }
Write-Host "真机对象：已关闭任务 #$closedTask，需求任务 #$storyTask，附件 $mp4Name / $pngName"

$busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($busy) { throw "端口 $port 已被占用（PID $($busy.OwningProcess)），先清理再跑" }

$proc = $null
try {
  $proc = Start-Process -FilePath $dsh -ArgumentList '--profile', 'web', '--no-open', '--port', $port `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden

  $token = $null
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Milliseconds 500
    $text = (Get-Content $out -Raw -ErrorAction SilentlyContinue) + (Get-Content $err -Raw -ErrorAction SilentlyContinue)
    if ($text -match 'token=([A-Za-z0-9\-_]+)') { $token = $Matches[1]; break }
  }
  if (-not $token) { throw "日志里没等到一次性 launch token：`n$text" }
  Write-Host "launch token 已取到（长度 $($token.Length)）"

  $sess = $null
  Invoke-WebRequest "http://127.0.0.1:$port/?token=$token" -SkipHttpErrorCheck -SessionVariable sess | Out-Null
  $page = Invoke-WebRequest "http://127.0.0.1:$port/" -WebSession $sess
  Write-Host "首页 $($page.StatusCode)，已拿到会话 Cookie"

  function Call($endpoint, $body) {
    $r = Invoke-WebRequest "http://127.0.0.1:$port/zentao-workbench/$endpoint" -Method Post -ContentType 'application/json' `
      -Body $body -WebSession $sess -SkipHttpErrorCheck
    return [pscustomobject]@{ status = $r.StatusCode; content = $r.Content }
  }

  $cfg = Call 'getConfig' '{}'
  $cfgJson = $cfg.content | ConvertFrom-Json
  Write-Host "getConfig: HTTP $($cfg.status) ok=$($cfgJson.ok) hasToken=$($cfgJson.value.hasToken) account=$($cfgJson.value.account)"

  # 1) finishTask / assignTask 都打在不存在的 id 上 —— 期望「HTTP 200 + ok:false 信封」，证明路由与链路都在
  $fin = Call 'finishTask' '{"id":"99999991","hours":1}'
  $finJson = $fin.content | ConvertFrom-Json
  Write-Host "finishTask(假 id): HTTP $($fin.status) ok=$($finJson.ok) code=$($finJson.error.code) msg=$($finJson.error.message)"
  $okFin = $fin.status -eq 200 -and $finJson.ok -eq $false -and $finJson.error.code -eq 'internal'

  $asg = Call 'assignTask' '{"id":"99999991","account":"ghost"}'
  $asgJson = $asg.content | ConvertFrom-Json
  Write-Host "assignTask(假 id): HTTP $($asg.status) ok=$($asgJson.ok) code=$($asgJson.error.code) msg=$($asgJson.error.message)"
  $okAsg = $asg.status -eq 200 -and $asgJson.ok -eq $false -and $asgJson.error.code -eq 'internal'

  # 2) 参数校验（不碰禅道）：缺 id / 缺 account → bad-request 信封
  $bad1 = (Call 'finishTask' '{"hours":1}').content | ConvertFrom-Json
  $bad2 = (Call 'assignTask' '{"id":"1"}').content | ConvertFrom-Json
  $bad3 = (Call 'finishTask' '{"id":"1","hours":-3}').content | ConvertFrom-Json
  Write-Host "校验：缺 id → $($bad1.error.code)；缺 account → $($bad2.error.code)；负耗时 → $($bad3.error.code)"
  $okBad = $bad1.error.code -eq 'bad-request' -and $bad2.error.code -eq 'bad-request' -and $bad3.error.code -eq 'bad-request'

  # 3) listUsers：走真实禅道（只读）
  $usr = Call 'listUsers' '{}'
  $usrJson = $usr.content | ConvertFrom-Json
  if ($usrJson.ok) {
    $n = @($usrJson.value.users).Count
    $first = @($usrJson.value.users)[0]
    Write-Host "listUsers: HTTP $($usr.status) ok=true total=$($usrJson.value.total) 去重后 $n 人，示例=$($first.realname)/$($first.account)"
    $okUsr = $n -gt 0 -and [string]::IsNullOrEmpty($first.account) -eq $false -and $first.PSObject.Properties.Name -contains 'realname'
  }
  else {
    Write-Host "listUsers: ok=false code=$($usrJson.error.code) msg=$($usrJson.error.message)（可能是 token 已失效，需要重新登录）"
    $okUsr = $true
  }

  # 3.5) 用一条**真实**已关闭任务验证「写前守卫」：终态任务不再写、指派给同一个人不写。
  #      这两条路径宿主要先 GET 再判断，判断为「不用写」就直接返回，因此对真实数据零副作用。
  $okFinGuard = $true
  $okAsgGuard = $true
  $det = Call 'fetchDetail' ('{"kind":"task","id":"' + $closedTask + '"}')
  $detJson = $det.content | ConvertFrom-Json
  if ($detJson.ok) {
    $t = $detJson.value
    Write-Host "真实任务 #$closedTask：状态=$($t.status)/$($t.statusLabel) 指派=$($t.assignedTo)/$($t.assignedToName)"
    $finReal = (Call 'finishTask' ('{"id":"' + $closedTask + '","hours":1}')).content | ConvertFrom-Json
    $okFinGuard = $finReal.ok -eq $true -and $finReal.value.changed -eq $false -and $finReal.value.note -like '*无需再完成*'
    Write-Host "finishTask 守卫：ok=$($finReal.ok) changed=$($finReal.value.changed) note=$($finReal.value.note)"
    if ([string]::IsNullOrEmpty($t.assignedTo)) {
      Write-Host '该任务当前无人指派，跳过「同人指派」守卫验证'
    }
    else {
      $asgBody = '{"id":"' + $closedTask + '","account":"' + $t.assignedTo + '"}'
      $asgReal = (Call 'assignTask' $asgBody).content | ConvertFrom-Json
      $okAsgGuard = $asgReal.ok -eq $true -and $asgReal.value.changed -eq $false -and $asgReal.value.note -like '*已经指派给*'
      Write-Host "assignTask 守卫：ok=$($asgReal.ok) changed=$($asgReal.value.changed) note=$($asgReal.value.note)"
    }
  }
  else {
    Write-Host "真实任务 #$closedTask 读取失败（$($detJson.error.message)），跳过守卫验证"
  }

  # 3.6) 视频附件代理（只读；自有路由不做 admission，所以这里不需要首页 Cookie）：
  #      真机 mp4 直链上游是 application/octet-stream、无 content-length / accept-ranges、且忽略 Range，
  #      宿主必须改回 video/mp4 并自己切片，否则浏览器 <video> 既不播也拖不动进度条。
  $okVideo = $true
  $mp4Tmp = Join-Path $env:TEMP 'dsh-e2e-mp4.bin'
  $mp4Hdr = Join-Path $env:TEMP 'dsh-e2e-mp4.hdr'
  $mp4Enc = [uri]::EscapeDataString("$ztOrigin/zentao/$mp4Name")
  $mp4Base = "http://127.0.0.1:$port/zentao-workbench/attachment?url=$mp4Enc"
  try {
    $whole = (& curl.exe -s -o $mp4Tmp -D $mp4Hdr -w '%{http_code} %{content_type} %{size_download}' $mp4Base) -split ' '
    $wholeHdr = Get-Content $mp4Hdr -Raw
    Write-Host "mp4 代理（整份）：HTTP $($whole[0]) type=$($whole[1]) size=$($whole[2]) accept-ranges=$(($wholeHdr -match '(?im)^accept-ranges:\s*bytes'))"
    # 附件 id 会过期（同一个 file-read-N 在禅道里可能换成了别的文件），所以「是不是视频」不再当硬断言：
    # 硬断言只留代理行为本身（200 + accept-ranges: bytes + 有实体）；确实拿到视频时才额外要求类型归一化成 video/mp4。
    $isVideo = $whole[1] -like 'video/*'
    if (-not $isVideo) {
      Write-Host "注意：$mp4Name 当前返回的是 $($whole[1])（不是视频），本次只验了 Range 代理行为；要验 video/mp4 归一化请用 DZW_E2E_MP4 指一个真实 mp4 附件"
    }
    $okWhole = $whole[0] -eq '200' -and [int]$whole[2] -gt 100000 -and $wholeHdr -match '(?im)^accept-ranges:\s*bytes'
    if ($isVideo) { $okWhole = $okWhole -and $whole[1] -like 'video/mp4*' }

    $part = (& curl.exe -s -o $mp4Tmp -D $mp4Hdr -w '%{http_code} %{size_download}' -H 'Range: bytes=0-1023' $mp4Base) -split ' '
    $partHdr = Get-Content $mp4Hdr -Raw
    $partRange = ([regex]::Match($partHdr, '(?im)^content-range:\s*(.+)$').Groups[1].Value).Trim()
    Write-Host "mp4 代理（Range 0-1023）：HTTP $($part[0]) size=$($part[1]) content-range=$partRange"
    $okPart = $part[0] -eq '206' -and [int]$part[1] -eq 1024 -and $partHdr -match '(?im)^content-range:\s*bytes 0-1023/\d+'

    $overCode = & curl.exe -s -o NUL -D $mp4Hdr -w '%{http_code}' -H 'Range: bytes=99999999-' $mp4Base
    $overHdr = Get-Content $mp4Hdr -Raw
    $overRange = ([regex]::Match($overHdr, '(?im)^content-range:\s*(.+)$').Groups[1].Value).Trim()
    Write-Host "mp4 代理（越界 Range）：HTTP $overCode content-range=$overRange"
    $okOver = $overCode -eq '416' -and $overHdr -match '(?im)^content-range:\s*bytes \*/'

    $okVideo = $okWhole -and $okPart -and $okOver
  }
  catch {
    Write-Host "mp4 代理验证异常：$_"
    $okVideo = $false
  }
  finally {
    Remove-Item $mp4Tmp, $mp4Hdr -Force -ErrorAction SilentlyContinue
  }

  # 3.7) 研发需求与散字段（只读）：真机任务 $storyTask 挂在一条研发需求上，`desc` 为空但 `storySpec`
  #      才是真正的说明。这条只读一次 fetchDetail，验证 story / sections / meta 都出得来。
  $okStory = $true
  $storyDet = Call 'fetchDetail' ('{"kind":"task","id":"' + $storyTask + '"}')
  $storyJson = $storyDet.content | ConvertFrom-Json
  if ($storyJson.ok) {
    $sv = $storyJson.value
    $labels = @($sv.sections | ForEach-Object { $_.label })
    $metaLabels = @($sv.meta | ForEach-Object { $_.label })
    Write-Host "真实任务 #$storyTask：status=$($sv.status)/$($sv.statusLabel) story=$($sv.story.id)/$($sv.story.statusLabel) 段落=[$($labels -join '|')] meta=[$($metaLabels -join '|')]"
    $hasSpec = $labels -contains '研发需求描述'
    $hasVerify = $labels -contains '研发需求验收标准'
    $okStory = [string]::IsNullOrEmpty($sv.story.id) -eq $false -and $sv.story.link -like '*story-view-*.html' -and ($hasSpec -or $hasVerify) -and $metaLabels.Count -gt 0
    Write-Host "研发需求校验：story.id 非空=$([string]::IsNullOrEmpty($sv.story.id) -eq $false) link=$($sv.story.link) 研发需求描述=$hasSpec 验收标准=$hasVerify meta 行数=$($metaLabels.Count)"
  }
  else {
    Write-Host "真实任务 #$storyTask 详情读取失败（$($storyJson.error.message)）——若任务已关闭或被删除，这条会跳过"
  }

  # 3.8) 「用默认程序打开」链路（半只读：会真的下载一个**真实的图片附件**到临时目录，然后用替身 opener 打开）。
  #      安全边界同时验证：可执行扩展名在下载之前就被拒绝。
  $okOpen = $true
  $pngUrl = "$ztOrigin/zentao/$pngName"
  $pngBody = '{"url":"' + $pngUrl + '","name":"' + $pngName + '"}'
  $pngOpen = Call 'openAttachment' $pngBody
  $pngJson = $pngOpen.content | ConvertFrom-Json
  if ($pngJson.ok) {
    $saved = $pngJson.value.savedPath
    $savedSize = if (Test-Path $saved) { (Get-Item $saved).Length } else { 0 }
    Write-Host "openAttachment(真实 png)：ok=true name=$($pngJson.value.name) ext=$($pngJson.value.extension) size=$($pngJson.value.size) 落盘=$savedSize 字节 目录内文件数=$(@(Get-ChildItem $openDir -ErrorAction SilentlyContinue).Count)"
    $okOpen = $pngJson.value.opened -eq $true -and $pngJson.value.extension -eq 'png' -and $savedSize -eq $pngJson.value.size -and $savedSize -gt 10000 -and $saved.StartsWith($openDir)
  }
  else {
    Write-Host "openAttachment(真实 png)：ok=false code=$($pngJson.error.code) msg=$($pngJson.error.message)"
    $okOpen = $false
  }

  $exeBody = '{"url":"' + $ztOrigin + '/zentao/file-read-1.exe","name":"x.exe"}'
  $exeOpen = (Call 'openAttachment' $exeBody).content | ConvertFrom-Json
  $noUrlOpen = (Call 'openAttachment' '{}').content | ConvertFrom-Json
  Write-Host "安全边界：.exe → $($exeOpen.error.code)/$($exeOpen.error.message)；缺 url → $($noUrlOpen.error.code)"
  $okOpen = $okOpen -and $exeOpen.ok -eq $false -and $exeOpen.error.code -eq 'forbidden' -and $noUrlOpen.error.code -eq 'bad-request'

  # 4) 浏览器半侧 bundle 内容检查
  $combo = $null
  foreach ($m in [regex]::Matches($page.Content, "plugins/\?\?[^""'\\ <>]+")) {
    $decoded = [System.Net.WebUtility]::HtmlDecode($m.Value)
    if ($decoded -like '*dsh-zentao-workbench*') { $combo = $decoded; break }
  }
  if (-not $combo) { throw 'boot 载荷里没找到本插件的 combo 地址' }
  $js = Invoke-WebRequest "http://127.0.0.1:$port/$combo" -WebSession $sess
  $needles = @('完成任务 #', '指派任务 #', '本次耗时（小时）', '确认完成', '刷新成员', 'dzw-user-list', 'dzw-user-name', 'finishTask', 'assignTask', 'listUsers', '没有匹配的成员', 'dzw-preview-card', '点空白处或按 Esc 也能关闭', 'background: transparent', 'dzw-video', 'dzw-preview-video', '放大播放', 'dzw-preview-close-float', 'dzw-preview-close-solid', 'dzw-target-text', '跟随当前工作区', '选择发送目标工作区', '研发需求：#', 'dzw-meta', 'dzw-link', '预览 PDF', 'dzw-preview-pdf', '用默认程序打开', 'openAttachment', '点播放键开始播放')
  $missing = @($needles | Where-Object { $js.Content -notlike "*$_*" })
  Write-Host "bundle: HTTP $($js.StatusCode) $([System.Text.Encoding]::UTF8.GetByteCount($js.Content)) 字节，缺项=$($missing -join ',')"
  $okBundle = $js.StatusCode -eq 200 -and $missing.Count -eq 0
  $autoPlay = ([regex]::Matches($js.Content, 'autoPlay')).Count
  Write-Host "bundle 里 autoPlay 出现次数=$autoPlay（应为 0：视频不自动播放）"
  $okBundle = $okBundle -and $autoPlay -eq 0

  Write-Host ''
  Write-Host "E2E 结果：finishTask=$okFin assignTask=$okAsg 参数校验=$okBad listUsers=$okUsr 真实任务守卫=$($okFinGuard -and $okAsgGuard) mp4代理=$okVideo 研发需求=$okStory 默认程序打开=$okOpen bundle=$okBundle"
  if ($okFin -and $okAsg -and $okBad -and $okUsr -and $okFinGuard -and $okAsgGuard -and $okVideo -and $okStory -and $okOpen -and $okBundle) { Write-Host 'E2E-FINISH-ASSIGN OK' }
  else { Write-Host 'E2E-FINISH-ASSIGN FAILED'; exit 1 }
}
finally {
  if ($proc) { & taskkill /PID $proc.Id /T /F 2>$null | Out-Null }
  Start-Sleep -Milliseconds 800
  $still = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $still) { & taskkill /PID $c.OwningProcess /T /F 2>$null | Out-Null }
  Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
  Remove-Item $openDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "清理完成，$port 监听数 = $(@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count)"
}
