$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Love2DPreviewWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
  [DllImport("user32.dll", SetLastError = true)] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", SetLastError = true)] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@

# Keep native window coordinates in physical pixels so the owned game window
# lands exactly on the DOM preview rectangle at every display scale.
try {
  [void][Love2DPreviewWin32]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
} catch {
  # Older Windows versions or an existing awareness context; positioning still works.
}

$script:gameHandle = [IntPtr]::Zero
$script:gamePid = 0
$script:gameParent = [IntPtr]::Zero
$script:gameX = 0
$script:gameY = 0
$script:gameWidth = 1
$script:gameHeight = 1
$script:originalStyle = $null
$script:originalExStyle = $null

function Write-Response($response) {
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}

function Get-ProcessWindow([int]$processId) {
  try {
    $process = Get-Process -Id $processId -ErrorAction Stop
    $process.Refresh()
    if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
      return $process.MainWindowHandle
    }
  } catch {
    return [IntPtr]::Zero
  }
  return [IntPtr]::Zero
}

function Get-DescendantProcessIds([int]$rootProcessId) {
  $seen = New-Object System.Collections.Generic.HashSet[int]
  $queue = New-Object System.Collections.Generic.Queue[int]
  [void]$seen.Add($rootProcessId)
  $queue.Enqueue($rootProcessId)
  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    try {
      $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$current" -ErrorAction SilentlyContinue)
    } catch {
      $children = @()
    }
    foreach ($child in $children) {
      $childId = [int]$child.ProcessId
      if ($seen.Add($childId)) {
        $queue.Enqueue($childId)
      }
    }
  }
  return @($seen)
}

function Find-WindowForProcessIds([int[]]$processIds) {
  $wanted = New-Object System.Collections.Generic.HashSet[int]
  foreach ($id in $processIds) { [void]$wanted.Add([int]$id) }
  $script:foundWindow = [IntPtr]::Zero
  $callback = [Love2DPreviewWin32+EnumWindowsProc]{
    param($windowHandle, $parameter)
    $windowPid = [uint32]0
    [void][Love2DPreviewWin32]::GetWindowThreadProcessId($windowHandle, [ref]$windowPid)
    if ($wanted.Contains([int]$windowPid)) {
      $rect = New-Object Love2DPreviewWin32+RECT
      [void][Love2DPreviewWin32]::GetWindowRect($windowHandle, [ref]$rect)
      $width = $rect.Right - $rect.Left
      $height = $rect.Bottom - $rect.Top
      if ($width -ge 100 -and $height -ge 100) {
        $script:foundWindow = $windowHandle
        return $false
      }
    }
    return $true
  }
  [void][Love2DPreviewWin32]::EnumWindows($callback, [IntPtr]::Zero)
  return $script:foundWindow
}

function Find-GameWindow([int]$rootProcessId) {
  $deadline = (Get-Date).AddSeconds(10)
  $tick = 0
  while ((Get-Date) -lt $deadline) {
    $handle = Get-ProcessWindow $rootProcessId
    if ($handle -ne [IntPtr]::Zero) {
      return $handle
    }
    if (($tick % 4) -eq 0) {
      $ids = @(Get-DescendantProcessIds $rootProcessId)
      $handle = Find-WindowForProcessIds $ids
      if ($handle -ne [IntPtr]::Zero) {
        return $handle
      }
    }
    $tick += 1
    Start-Sleep -Milliseconds 200
  }
  throw "The game window did not appear. Check the live console for LÖVE errors."
}

function Set-GameBounds([int]$x, [int]$y, [int]$width, [int]$height) {
  if ($script:gameHandle -eq [IntPtr]::Zero) {
    throw "No game is attached."
  }
  $script:gameX = $x
  $script:gameY = $y
  $script:gameWidth = [Math]::Max(1, $width)
  $script:gameHeight = [Math]::Max(1, $height)
  $origin = New-Object Love2DPreviewWin32+POINT
  $origin.X = 0
  $origin.Y = 0
  if (-not [Love2DPreviewWin32]::ClientToScreen($script:gameParent, [ref]$origin)) {
    throw "Could not locate the Studio window on screen."
  }
  [void][Love2DPreviewWin32]::SetWindowPos(
    $script:gameHandle,
    [IntPtr]::Zero,
    $origin.X + $script:gameX,
    $origin.Y + $script:gameY,
    $script:gameWidth,
    $script:gameHeight,
    0x0014
  )
}

[Console]::Out.WriteLine('{"event":"ready"}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }

  $response = @{ ok = $false; error = "Unknown command." }
  $requestId = ""
  $command = $null
  try {
    $command = $line | ConvertFrom-Json
    $requestId = [string]$command.id
    switch ([string]$command.op) {
      "attach" {
        $pidValue = [int]$command.pid
        $parent = [IntPtr]([Int64]$command.parentHwnd)
        if ($pidValue -le 0 -or $parent -eq [IntPtr]::Zero) {
          throw "A valid game process and parent window are required."
        }
        $handle = Find-GameWindow $pidValue
        [Console]::Error.WriteLine("[helper] attaching pid=$pidValue hwnd=$($handle.ToInt64()) parent=$($parent.ToInt64())")
        $script:originalStyle = [Love2DPreviewWin32]::GetWindowLong($handle, -16)
        $script:originalExStyle = [Love2DPreviewWin32]::GetWindowLong($handle, -20)
        # Keep the game as a top-level popup with the Studio window as its
        # owner. Chromium's DirectComposition surface can cover a true child
        # HWND, but an owned window stays above its owner and keeps rendering.
        $newStyle = [int](($script:originalStyle -band (-bnot 0x80CF0000)) -bor 0x80000000)
        $newExStyle = [int](($script:originalExStyle -band (-bnot 0x00040301)) -bor 0x00000080)
        [void][Love2DPreviewWin32]::SetWindowLong($handle, -16, $newStyle)
        [void][Love2DPreviewWin32]::SetWindowLong($handle, -20, $newExStyle)
        [void][Love2DPreviewWin32]::SetWindowLongPtr($handle, -8, $parent)
        $script:gameHandle = $handle
        $script:gamePid = $pidValue
        $script:gameParent = $parent
        Set-GameBounds ([int]$command.x) ([int]$command.y) ([int]$command.width) ([int]$command.height)
        [void][Love2DPreviewWin32]::ShowWindow($handle, 5)
        $response = @{
          ok = $true
          hwnd = $handle.ToInt64().ToString()
          pid = $pidValue
        }
      }
      "bounds" {
        Set-GameBounds ([int]$command.x) ([int]$command.y) ([int]$command.width) ([int]$command.height)
        $response = @{ ok = $true }
      }
      "visibility" {
        if ($script:gameHandle -eq [IntPtr]::Zero) {
          throw "No game is attached."
        }
        $show = [bool]$command.visible
        [void][Love2DPreviewWin32]::ShowWindow($script:gameHandle, $(if ($show) { 5 } else { 0 }))
        $response = @{ ok = $true; visible = $show }
      }
      "detach" {
        if ($script:gameHandle -ne [IntPtr]::Zero) {
          [void][Love2DPreviewWin32]::ShowWindow($script:gameHandle, 0)
          [void][Love2DPreviewWin32]::SetWindowLongPtr($script:gameHandle, -8, [IntPtr]::Zero)
          if ($null -ne $script:originalStyle) {
            [void][Love2DPreviewWin32]::SetWindowLong($script:gameHandle, -16, $script:originalStyle)
          }
          if ($null -ne $script:originalExStyle) {
            [void][Love2DPreviewWin32]::SetWindowLong($script:gameHandle, -20, $script:originalExStyle)
          }
        }
        $script:gameHandle = [IntPtr]::Zero
        $script:gamePid = 0
        $script:gameParent = [IntPtr]::Zero
        $response = @{ ok = $true }
      }
      "quit" {
        $response = @{ ok = $true }
        break
      }
      default {
        throw "Unknown command: $($command.op)"
      }
    }
  } catch {
    $response = @{ ok = $false; error = $_.Exception.Message }
  }

  if ($requestId) {
    $response.id = $requestId
  }
  Write-Response $response
  if ($null -ne $command -and [string]$command.op -eq "quit") { break }
}
