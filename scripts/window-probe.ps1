# Native Windows checks for the explicitly selected test application only.
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [ValidateSet('inspect', 'place', 'restore', 'maximize', 'hover', 'click-maximize', 'activate-maximize', 'drag', 'snap-left', 'move', 'resize')][string]$Action = 'inspect',
    [string]$Screenshot
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PawnWindowProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hwnd, EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int mode);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint first, uint second, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public static string Class(IntPtr h) { var s=new StringBuilder(256); GetClassName(h,s,256); return s.ToString(); }
  public static IntPtr Window(uint processId) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((h,data)=> { uint pid; GetWindowThreadProcessId(h,out pid); if(pid==processId && Class(h)=="Tauri Window") found=h; return true; },IntPtr.Zero);
    return found;
  }
  public static bool Focus(IntPtr h) {
    ShowWindow(h,IsIconic(h)?9:5);
    if(!IsWindowVisible(h)) ShowWindow(h,5);
    if(GetForegroundWindow()==h) return true;
    uint pid;
    uint foreground=GetWindowThreadProcessId(GetForegroundWindow(),out pid);
    uint current=GetCurrentThreadId();
    bool attached=current!=foreground && AttachThreadInput(current,foreground,true);
    try { BringWindowToTop(h); SetForegroundWindow(h); }
    finally { if(attached) AttachThreadInput(current,foreground,false); }
    return GetForegroundWindow()==h;
  }
  public static IntPtr Overlay(IntPtr h) {
    IntPtr found=IntPtr.Zero;
    EnumChildWindows(h,(child,data)=> { if(Class(child)=="TauriFrameSnapOverlay") found=child; return true; },IntPtr.Zero);
    return found;
  }
  public static long Hit(IntPtr h,int x,int y) { return SendMessage(h,0x84,IntPtr.Zero,new IntPtr((y<<16)|(x&65535))).ToInt64(); }
}
'@
[void][PawnWindowProbe]::SetProcessDpiAwarenessContext([IntPtr](-4))
$testProcess = Get-Process -Id $ProcessId
if ($testProcess.ProcessName -ne 'ompide') { throw 'Select only the ompide test application.' }
$testWindow = [PawnWindowProbe]::Window($ProcessId)
if ($testWindow -eq [IntPtr]::Zero) { throw 'Test window is unavailable.' }
$overlay = [PawnWindowProbe]::Overlay($testWindow)
$windowRect = New-Object PawnWindowProbe+Rect
[void][PawnWindowProbe]::GetWindowRect($testWindow, [ref]$windowRect)
switch ($Action) {
    'activate-maximize' {
        if ($overlay -eq [IntPtr]::Zero) { throw 'Snap overlay is unavailable.' }
        # Drive the real native hit-test window directly so a person moving the
        # desktop mouse during the test cannot redirect these button messages.
        [void][PawnWindowProbe]::SendMessage($overlay,0xa1,[IntPtr]9,[IntPtr]::Zero)
        [void][PawnWindowProbe]::SendMessage($overlay,0xa2,[IntPtr]9,[IntPtr]::Zero)
    }
    'place' {
        [void][PawnWindowProbe]::ShowWindow($testWindow,9)
        [void][PawnWindowProbe]::SetWindowPos($testWindow,[IntPtr]::Zero,40,40,[Math]::Min(2200,[PawnWindowProbe]::GetSystemMetrics(0)-80),[Math]::Min(1400,[PawnWindowProbe]::GetSystemMetrics(1)-80),4)
    }
    'restore' {
        [void][PawnWindowProbe]::ShowWindow($testWindow, 9)
        [void][PawnWindowProbe]::ShowWindow($testWindow, 5)
        [void][PawnWindowProbe]::SetForegroundWindow($testWindow)
    }
    'maximize' { [void][PawnWindowProbe]::ShowWindow($testWindow, 3) }
    'move' { [void][PawnWindowProbe]::SetWindowPos($testWindow, [IntPtr]::Zero, ($windowRect.Left+30), ($windowRect.Top+20), 0, 0, 5) }
    'resize' { [void][PawnWindowProbe]::SetWindowPos($testWindow, [IntPtr]::Zero, 0, 0, 1100, 760, 6) }
    'snap-left' {
        if (![PawnWindowProbe]::Focus($testWindow)) { throw 'Could not focus the selected test window.' }
        [PawnWindowProbe]::keybd_event(0x5b,0,0,[UIntPtr]::Zero)
        [PawnWindowProbe]::keybd_event(0x25,0,0,[UIntPtr]::Zero)
        [PawnWindowProbe]::keybd_event(0x25,0,2,[UIntPtr]::Zero)
        [PawnWindowProbe]::keybd_event(0x5b,0,2,[UIntPtr]::Zero)
    }
    { $_ -in 'hover','click-maximize' } {
        if ($overlay -eq [IntPtr]::Zero) { throw 'Snap overlay is unavailable.' }
        if (![PawnWindowProbe]::Focus($testWindow)) { throw 'Could not focus the selected test window.' }
        $hoverRect = New-Object PawnWindowProbe+Rect
        [void][PawnWindowProbe]::GetWindowRect($overlay, [ref]$hoverRect)
        [void][PawnWindowProbe]::SetCursorPos(($hoverRect.Left+$hoverRect.Right)/2, ($hoverRect.Top+$hoverRect.Bottom)/2)
        if ($Action -eq 'click-maximize') {
            [PawnWindowProbe]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
            [PawnWindowProbe]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
        }
    }
    'drag' {
        if (![PawnWindowProbe]::Focus($testWindow)) { throw 'Could not focus the selected test window.' }
        $dragOverlay = New-Object PawnWindowProbe+Rect
        [void][PawnWindowProbe]::GetWindowRect($overlay,[ref]$dragOverlay)
        $dragScale = ($dragOverlay.Bottom-$dragOverlay.Top)/34
        $dragX = [int]($windowRect.Left+($windowRect.Right-$windowRect.Left)*0.6)
        $dragY = [int]($windowRect.Top+20*$dragScale)
        [void][PawnWindowProbe]::SetCursorPos($dragX,$dragY)
        [PawnWindowProbe]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
        try {
            Start-Sleep -Milliseconds 700
            [PawnWindowProbe]::mouse_event(1,80,40,0,[UIntPtr]::Zero)
            Start-Sleep -Milliseconds 300
        } finally { [PawnWindowProbe]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
    }
}
if ($Action -ne 'inspect') { Start-Sleep -Milliseconds 1200 }
[void][PawnWindowProbe]::GetWindowRect($testWindow, [ref]$windowRect)
$overlay = [PawnWindowProbe]::Overlay($testWindow)
$overlayRect = New-Object PawnWindowProbe+Rect
if ($overlay -ne [IntPtr]::Zero) { [void][PawnWindowProbe]::GetWindowRect($overlay,[ref]$overlayRect) }
if ($Screenshot) {
    Add-Type -AssemblyName System.Drawing
    $capture = New-Object System.Drawing.Bitmap ($windowRect.Right-$windowRect.Left),($windowRect.Bottom-$windowRect.Top)
    $graphics = [System.Drawing.Graphics]::FromImage($capture)
    try {
        $graphics.CopyFromScreen($windowRect.Left,$windowRect.Top,0,0,$capture.Size)
        $capture.Save([System.IO.Path]::GetFullPath($Screenshot))
    } finally { $graphics.Dispose(); $capture.Dispose() }
}
[ordered]@{
    windowClass = [PawnWindowProbe]::Class($testWindow)
    maximized = [PawnWindowProbe]::IsZoomed($testWindow)
    minimized = [PawnWindowProbe]::IsIconic($testWindow)
    visible = [PawnWindowProbe]::IsWindowVisible($testWindow)
    nativeCaption = (([PawnWindowProbe]::GetWindowLong($testWindow,-16) -band 0x00c00000) -eq 0x00c00000)
    window = $windowRect
    overlay = $overlayRect
    overlayHit = if ($overlay -ne [IntPtr]::Zero) { [PawnWindowProbe]::Hit($overlay, ($overlayRect.Left+$overlayRect.Right)/2, ($overlayRect.Top+$overlayRect.Bottom)/2) } else { 0 }
    topResizeHit = [PawnWindowProbe]::Hit($testWindow, $windowRect.Left+100, $windowRect.Top+1)
} | ConvertTo-Json -Depth 4 -Compress
