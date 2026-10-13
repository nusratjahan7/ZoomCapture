<#
  Test probe for the ZoomCapture controls helper window (on the real desktop):
    -Action Capture : puts a white window under the controls, takes a screenshot of that area the
                      way screen recorders do, and reports how much of it is white (the controls
                      left out) or the controls' dark colour (the controls captured).
    -Action Click   : clicks one of its buttons, found by name through UI Automation.
  Prints one line of JSON.
#>
param(
  [ValidateSet('Capture', 'Click')][string]$Action,
  [string]$Name = '',
  [int]$ProcessId
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ProbeNative {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);
  public static IntPtr Find(uint processId) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, l) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      var text = new StringBuilder(256); GetWindowText(hwnd, text, 256);
      if (pid == processId && IsWindowVisible(hwnd) && text.ToString() == "ZoomCapture controls") { found = hwnd; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
[void][ProbeNative]::SetProcessDPIAware()

$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 40 -and $hwnd -eq [IntPtr]::Zero; $i++) {
  $hwnd = [ProbeNative]::Find([uint32]$ProcessId)
  if ($hwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output '{"found":false}'; exit 0 }
$rect = New-Object ProbeNative+RECT
[void][ProbeNative]::GetWindowRect($hwnd, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

if ($Action -eq 'Click') {
  $root = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $condition = New-Object Windows.Automation.PropertyCondition ([Windows.Automation.AutomationElement]::NameProperty), $Name
  $button = $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
  if (-not $button) { Write-Output (@{ found = $true; clicked = $false } | ConvertTo-Json -Compress); exit 0 }
  # Press and release the left button on it (window messages, so the real mouse doesn't move).
  $target = New-Object IntPtr $button.Current.NativeWindowHandle
  $box = $button.Current.BoundingRectangle
  $centre = [int]($box.Height / 2) * 65536 + [int]($box.Width / 2)
  [void][ProbeNative]::PostMessage($target, 0x0201, (New-Object IntPtr 1), (New-Object IntPtr $centre))
  [void][ProbeNative]::PostMessage($target, 0x0202, [IntPtr]::Zero, (New-Object IntPtr $centre))
  Write-Output (@{ found = $true; clicked = $true } | ConvertTo-Json -Compress)
  exit 0
}

# A white, always-on-top window under the controls (the controls are raised back above it).
$backdrop = New-Object Windows.Forms.Form
$backdrop.FormBorderStyle = 'None'
$backdrop.ShowInTaskbar = $false
$backdrop.TopMost = $true
$backdrop.BackColor = [Drawing.Color]::White
$backdrop.StartPosition = 'Manual'
$backdrop.Bounds = New-Object Drawing.Rectangle ($rect.Left - 20), ($rect.Top - 20), ($width + 40), ($height + 40)
$backdrop.Show()
[Windows.Forms.Application]::DoEvents()
$HWND_TOPMOST = New-Object IntPtr -1
[void][ProbeNative]::SetWindowPos($hwnd, $HWND_TOPMOST, 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010 -bor 0x0040)
for ($i = 0; $i -lt 6; $i++) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }

# Screen copy of the controls' area, as a screen recorder sees it.
$bitmap = New-Object Drawing.Bitmap $width, $height
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
$white = 0; $dark = 0; $total = 0
for ($x = 2; $x -lt $width - 2; $x += 3) {
  for ($y = 2; $y -lt $height - 2; $y += 3) {
    $c = $bitmap.GetPixel($x, $y)
    $total++
    if ($c.R -gt 240 -and $c.G -gt 240 -and $c.B -gt 240) { $white++ }
    elseif ($c.R -lt 40 -and $c.G -lt 40 -and $c.B -lt 50) { $dark++ }
  }
}
$graphics.Dispose(); $bitmap.Dispose(); $backdrop.Close()
Write-Output (@{
  found = $true
  rect = @{ left = $rect.Left; top = $rect.Top; width = $width; height = $height }
  white = [math]::Round($white / $total, 3)
  dark = [math]::Round($dark / $total, 3)
} | ConvertTo-Json -Compress)
